// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IMoonVault} from "./interfaces/IMoonVault.sol";

/**
 * @title MoonVault
 * @dev A smart contract for managing betting positions on asset prices
 * @author Shivansh
 * @notice This contract allows users to take long or short positions on asset prices
 */
contract MoonVault is
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IMoonVault
{
    uint128 count;
    uint128 public stalenessThreshold;
    IERC20 usdc;
    IPyth oracle;
    bytes32 assetId;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_COLLATERAL = 1e6;

    mapping(uint256 => BetDetails) private _betDetails;
    mapping(address => mapping(uint256 => UserPosition)) private _userPosition;
    mapping(uint256 => uint256) public liquidationCollateral;

    /**
     * @dev Initializer function (replaces constructor)
     * @param _oracle Address of the oracle contract
     * @param _usdc Address of the usdc token contract
     */
    function initialize(
        address _oracle,
        address _usdc,
        bytes32 _assetId,
        address initialOwner
    ) public initializer {
        if (_oracle == address(0)) revert MV_InvalidOracle();

        __Ownable_init(initialOwner);
        __Pausable_init();
        oracle = IPyth(_oracle);
        usdc = IERC20(_usdc);
        assetId = _assetId;
        stalenessThreshold = 30 minutes;
    }

    function createBet(
        uint256 duration,
        uint256 depositPeriod,
        uint256 longGameTokens,
        uint256 shortGameTokens,
        uint256 initialLiquidity
    ) external override onlyOwner {
        require(duration > depositPeriod, MV_InvalidDuration());

        uint256 currentPrice = _getPrice();
        require(currentPrice > 0, MV_InvalidOraclePrice());
        require(
            usdc.transferFrom(msg.sender, address(this), initialLiquidity),
            MV_TransferFailed()
        );
        uint256 newcount;
        uint256 halfLiquidity;
        unchecked {
            newcount = count++;
            halfLiquidity = initialLiquidity / 2;
        }

        _betDetails[newcount] = BetDetails({
            initialAssetPrice: uint128(currentPrice),
            closePrice: 0,
            numPlayers: 0,
            longGameTokens: longGameTokens,
            shortGameTokens: shortGameTokens,
            longCollateral: halfLiquidity,
            shortCollateral: halfLiquidity,
            startTime: uint40(block.timestamp),
            closeTime: 0,
            duration: uint40(duration),
            depositPeriod: uint40(depositPeriod),
            isOpen: true
        });
        emit BetCreated(newcount, duration, currentPrice);
    }

    function placeBet(
        uint256 betId,
        bool isLong,
        uint256 collateral,
        uint256 positionSize
    ) external override nonReentrant whenNotPaused {
        require(collateral >= MIN_COLLATERAL, MV_CollateralTooLow());
        require(positionSize > collateral, MV_InvalidPositionSize());

        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, MV_BetNotOpen());
        require(
            block.timestamp <= bet.startTime + bet.depositPeriod,
            MV_DepositPeriodEnded()
        );

        uint256 currentPrice = _getPrice();
        require(currentPrice > 0, MV_InvalidOraclePrice());

        uint256 liquidationPrice;
        uint256 liquidationMargin = (collateral * PRECISION) / positionSize;
        if (isLong) {
            liquidationPrice =
                (currentPrice * (PRECISION - liquidationMargin)) /
                PRECISION;
        } else {
            liquidationPrice =
                (currentPrice * (PRECISION + liquidationMargin)) /
                PRECISION;
        }

        require(
            usdc.transferFrom(msg.sender, address(this), collateral),
            MV_TransferFailed()
        );
        uint256 leverage = positionSize / collateral;

        uint256 gameTokenPrice = _getGameTokenPrice(betId, isLong);

        uint256 gameTokens = ((collateral * PRECISION) / gameTokenPrice) *
            leverage;

        UserPosition storage position = _userPosition[msg.sender][betId];
        position.isLong = isLong;
        position.collateral = collateral;
        position.positionSize = positionSize;
        position.entryPrice = uint104(currentPrice);
        position.liquidationPrice = uint104(liquidationPrice);
        position.isLiquidated = false;
        position.entryTime = uint40(block.timestamp);
        position.gameTokens = gameTokens;

        if (isLong) {
            bet.longCollateral += collateral;
            bet.longGameTokens += gameTokens;
        } else {
            bet.shortCollateral += collateral;
            bet.shortGameTokens += gameTokens;
        }
        unchecked {
            bet.numPlayers++;
        }
        emit PositionPlaced(
            msg.sender,
            betId,
            isLong,
            collateral,
            positionSize
        );
    }

    function liquidatePosition(
        address user,
        uint256 betId
    ) external override nonReentrant {
        UserPosition storage position = _userPosition[user][betId];
        BetDetails storage bet = _betDetails[betId];
        require(position.collateral > 0, MV_NoPositionFound());
        require(!position.isLiquidated, MV_AlreadyLiquidated());

        uint256 currentPrice = _getPrice();
        require(currentPrice > 0, MV_InvalidOraclePrice());

        bool shouldLiquidate = position.isLong
            ? currentPrice <= position.liquidationPrice
            : currentPrice >= position.liquidationPrice;

        require(shouldLiquidate, MV_CannotLiquidate());

        // Update bet details game tokens
        if (position.isLong) {
            bet.longGameTokens -= position.gameTokens;
            bet.longCollateral -= position.collateral;
        } else {
            bet.shortGameTokens -= position.gameTokens;
            bet.shortCollateral -= position.collateral;
        }

        liquidationCollateral[betId] += position.collateral;
        position.positionSize = 0;
        position.isLiquidated = true;
        position.gameTokens = 0;

        emit PositionLiquidated(user, betId);
    }

    function endBet(uint256 betId) external override onlyOwner whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, MV_BetAlreadyClosed());
        require(
            block.timestamp >= bet.startTime + bet.duration,
            MV_BetDurationNotEnded()
        );

        uint256 currentPrice = _getPrice();
        require(currentPrice > 0, MV_InvalidOraclePrice());

        bet.closePrice = uint128(currentPrice);
        bet.closeTime = uint40(block.timestamp);
        bet.isOpen = false;

        emit BetEnded(betId, currentPrice);
    }

    function claimRewards(
        uint256 betId
    ) external override nonReentrant whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(!bet.isOpen, MV_BetNotOpen());

        UserPosition storage position = _userPosition[msg.sender][betId];
        require(!position.isLiquidated, MV_PositionAlreadyLiquidated());
        require(position.collateral > 0, MV_NoPositionFound());

        bool isLongWinner = bet.closePrice > bet.initialAssetPrice;
        bool isWinner = position.isLong == isLongWinner;

        uint256 totalCollateral = position.isLong
            ? bet.shortCollateral + liquidationCollateral[betId]
            : bet.longCollateral + liquidationCollateral[betId];

        uint256 userShare;
        if (isWinner) {
            uint256 totalWinningTokens = position.isLong
                ? bet.longGameTokens
                : bet.shortGameTokens;

            userShare =
                (position.gameTokens * totalCollateral) /
                totalWinningTokens;
        }

        position.collateral = 0;
        position.positionSize = 0;
        position.gameTokens = 0;

        if (userShare > 0) {
            require(usdc.transfer(msg.sender, userShare), MV_TransferFailed());
        }

        emit RewardsClaimed(msg.sender, betId, userShare);
    }

    function earlyExit(
        uint256 betId,
        uint256 exitGameTokens
    ) external override nonReentrant whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        uint40 currentTime = uint40(block.timestamp);
        uint40 startTime = bet.startTime;
        require(
            currentTime <= startTime + bet.depositPeriod,
            MV_DepositPeriodEnded()
        );

        UserPosition storage position = _userPosition[msg.sender][betId];
        require(
            exitGameTokens > 0 && exitGameTokens <= position.gameTokens,
            MV_InvalidGameTokens()
        );

        uint256 proportionalSize = (exitGameTokens * position.positionSize) /
            position.gameTokens;

        uint256 proportionalCollateral = (proportionalSize *
            position.collateral) / position.positionSize;

        uint256 timeElapsed = currentTime - startTime;
        uint256 feePercentage = (timeElapsed * 100) / bet.duration;
        uint256 fee = (proportionalCollateral * feePercentage) / 100;
        uint256 returnAmount = proportionalCollateral - fee;
        if (position.isLong) {
            bet.longCollateral -= proportionalCollateral;
            bet.longGameTokens -= exitGameTokens;
        } else {
            bet.shortCollateral -= proportionalCollateral;
            bet.shortGameTokens -= exitGameTokens;
        }
        position.positionSize -= proportionalSize;
        position.collateral -= proportionalCollateral;
        position.gameTokens -= exitGameTokens;

        liquidationCollateral[betId] += fee;

        require(usdc.transfer(msg.sender, returnAmount), MV_TransferFailed());

        emit EarlyExit(msg.sender, betId, returnAmount);
    }

    function pause() external override onlyOwner {
        _pause();
    }

    function unpause() external override onlyOwner {
        _unpause();
    }

    function betDetails(
        uint256 betId
    ) external view override returns (BetDetails memory) {
        return _betDetails[betId];
    }

    function userPosition(
        address user,
        uint256 betId
    ) external view override returns (UserPosition memory) {
        return _userPosition[user][betId];
    }

    function recoverToken(
        address tokenAddress,
        uint256 amount
    ) external override onlyOwner {
        require(tokenAddress != address(usdc), MV_CannotRecoverVaultToken());
        require(
            IERC20(tokenAddress).transfer(owner(), amount),
            MV_TransferFailed()
        );
    }

    function setStalenessThreshold(
        uint256 _stalenessThreshold
    ) external onlyOwner {
        require(_stalenessThreshold > 0, MV_InvalidStalenessThreshold());
        stalenessThreshold = uint128(_stalenessThreshold);
    }
    function getGameTokenPrice(
        uint256 betId,
        bool isLong
    ) external view returns (uint256) {
        return _getGameTokenPrice(betId, isLong);
    }

    function _getPrice() internal view returns (uint256 price) {
        uint256 currentTimestamp = block.timestamp;
        PythStructs.Price memory retrievedPrice = oracle.getPriceNoOlderThan(
            assetId,
            stalenessThreshold
        );
        /*
        retrievedPrice.price fixed-point representation base
        retrievedPrice.expo fixed-point representation exponent (to go from base to decimal)
        retrievedPrice.conf fixed-point representation of confidence         
        i.e. 
        .price = 12276250
        .expo = -5
        price = 12276250 * 10^(-5) =  122.76250
        to go to 18 decimals => rebasedPrice = 12276250 * 10^(18-5) = 122762500000000000000
        */

        // Adjust exponent (using base as 18 decimals)
        uint baseConvertion = 10 ** uint(int(18) + retrievedPrice.expo);

        price = uint(retrievedPrice.price * int(baseConvertion));
    }
    /**
     * @dev Calculates the game token price based on the current pool ratio
     * @param betId Identifier of the bet
     * @param isLong Whether calculating for long position
     * @return price Game token price in USDC (with 18 decimals precision)
     */
    function _getGameTokenPrice(
        uint256 betId,
        bool isLong
    ) internal view returns (uint256) {
        BetDetails storage bet = _betDetails[betId];
        uint256 totalGameTokens = bet.longGameTokens + bet.shortGameTokens;
        if (isLong) {
            return (bet.longGameTokens * PRECISION) / totalGameTokens;
        } else {
            return (bet.shortGameTokens * PRECISION) / totalGameTokens;
        }
    }
}
