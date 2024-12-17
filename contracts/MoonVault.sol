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
    uint256 count;
    IERC20 usdc;
    IPyth oracle;
    bytes32 assetId;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_COLLATERAL = 1e6;
    uint256 public stalenessThreshold;

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

    /**
     * @notice Creates a new betting round
     * @dev Only callable by contract owner
     * @param duration Total duration of the bet
     * @param depositPeriod Period during which deposits are allowed
     */
    function createBet(
        uint256 duration,
        uint256 depositPeriod,
        uint256 longGameTokens,
        uint256 shortGameTokens,
        uint256 initialLiquidity
    ) external onlyOwner {
        require(duration > depositPeriod, MV_InvalidDuration());

        uint256 currentPrice = _getPrice();
        require(currentPrice != 0, MV_InvalidOraclePrice());
        require(
            usdc.transferFrom(msg.sender, address(this), initialLiquidity),
            MV_TransferFailed()
        );

        uint256 newcount = count++;

        _betDetails[newcount] = BetDetails({
            initialAssetPrice: currentPrice,
            numPlayers: 0,
            isOpen: true,
            closePrice: 0,
            closeTime: 0,
            startTime: block.timestamp,
            duration: duration,
            longGameTokens: longGameTokens,
            shortGameTokens: shortGameTokens,
            longCollateral: initialLiquidity / 2,
            shortCollateral: initialLiquidity / 2,
            depositPeriod: depositPeriod
        });

        emit BetCreated(newcount, duration, currentPrice);
    }

    /**
     * @notice Places a bet in an active betting round
     * @param betId Identifier of the bet
     * @param isLong Whether position is long
     * @param collateral Amount of collateral to deposit
     * @param positionSize Size of the position
     */
    function placeBet(
        uint256 betId,
        bool isLong,
        uint256 collateral,
        uint256 positionSize
    ) external nonReentrant whenNotPaused {
        require(collateral >= MIN_COLLATERAL, MV_CollateralTooLow());
        require(positionSize > collateral, MV_InvalidPositionSize());

        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, MV_BetNotOpen());
        require(
            block.timestamp <= bet.startTime + bet.depositPeriod,
            MV_DepositPeriodEnded()
        );

        uint256 currentPrice = _getPrice();
        require(currentPrice != 0, MV_InvalidOraclePrice());

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
        position.entryPrice = currentPrice;
        position.liquidationPrice = liquidationPrice;
        position.isLiquidated = false;
        position.entryTime = block.timestamp;
        position.gameTokens = gameTokens;

        if (isLong) {
            bet.longCollateral += collateral;
            bet.longGameTokens += gameTokens;
        } else {
            bet.shortCollateral += collateral;
            bet.shortGameTokens += gameTokens;
        }

        bet.numPlayers++;

        emit PositionPlaced(
            msg.sender,
            betId,
            isLong,
            collateral,
            positionSize
        );
    }

    /**
     * @notice Liquidates a user's position
     * @param user Address of the user to liquidate
     * @param betId Identifier of the bet
     */
    function liquidatePosition(
        address user,
        uint256 betId
    ) external nonReentrant {
        UserPosition storage position = _userPosition[user][betId];
        BetDetails storage bet = _betDetails[betId];
        require(position.collateral != 0, MV_NoPositionFound());
        require(!position.isLiquidated, MV_AlreadyLiquidated());

        uint256 currentPrice = _getPrice();
        require(currentPrice != 0, MV_InvalidOraclePrice());

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

    /**
     * @notice Ends a betting round
     * @dev Only callable by contract owner
     * @param betId Identifier of the bet to end
     */
    function endBet(uint256 betId) external onlyOwner whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, MV_BetAlreadyClosed());
        require(
            block.timestamp >= bet.startTime + bet.duration,
            MV_BetDurationNotEnded()
        );

        uint256 currentPrice = _getPrice();
        require(currentPrice != 0, MV_InvalidOraclePrice());

        bet.closePrice = currentPrice;
        bet.closeTime = block.timestamp;
        bet.isOpen = false;

        emit BetEnded(betId, currentPrice);
    }

    /**
     * @notice Claims rewards for a closed betting round
     * @param betId Identifier of the bet
     */
    function claimRewards(uint256 betId) external nonReentrant whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(!bet.isOpen, MV_BetNotOpen());

        UserPosition storage position = _userPosition[msg.sender][betId];
        require(!position.isLiquidated, MV_PositionAlreadyLiquidated());
        require(position.collateral != 0, MV_NoPositionFound());

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

    /**
     * @notice Allows early exit from a position
     * @param betId Identifier of the bet
     * @param exitGameTokens Number of game tokens to exit with
     */
    function earlyExit(
        uint256 betId,
        uint256 exitGameTokens
    ) external nonReentrant whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(!bet.isOpen, MV_DepositsStillOpen());

        UserPosition storage position = _userPosition[msg.sender][betId];
        require(
            exitGameTokens != 0 && exitGameTokens <= position.gameTokens,
            MV_InvalidGameTokens()
        );

        uint256 proportionalSize = (exitGameTokens * position.positionSize) /
            position.gameTokens;
        uint256 proportionalCollateral = (proportionalSize *
            position.collateral) / position.positionSize;

        uint256 timeElapsed = block.timestamp - bet.startTime;
        uint256 feePercentage = (timeElapsed * 100) / bet.duration;
        uint256 fee = (proportionalCollateral * feePercentage) / 100;
        uint256 returnAmount = proportionalCollateral - fee;

        position.positionSize -= proportionalSize;
        position.collateral -= proportionalCollateral;
        position.gameTokens -= exitGameTokens;

        liquidationCollateral[betId] += fee;

        require(usdc.transfer(msg.sender, returnAmount), MV_TransferFailed());

        emit EarlyExit(msg.sender, betId, returnAmount);
    }

    /**
     * @notice Pauses the contract
     * @dev Only callable by contract owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     * @dev Only callable by contract owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    function betDetails(
        uint256 betId
    ) external view returns (BetDetails memory) {
        return _betDetails[betId];
    }

    function userPosition(
        address user,
        uint256 betId
    ) external view returns (UserPosition memory) {
        return _userPosition[user][betId];
    }

    /**
     * @notice Recovers ERC20 tokens accidentally sent to the contract
     * @dev Only callable by contract owner, cannot recover MoonVault token
     * @param tokenAddress Address of the token to recover
     * @param amount Amount of tokens to recover
     */
    function recoverToken(
        address tokenAddress,
        uint256 amount
    ) external onlyOwner {
        require(tokenAddress != address(usdc), MV_CannotRecoverVaultToken());
        require(
            IERC20(tokenAddress).transfer(owner(), amount),
            MV_TransferFailed()
        );
    }

    function setStalenessThreshold(
        uint256 _stalenessThreshold
    ) external onlyOwner {
        require(_stalenessThreshold != 0, MV_InvalidStalenessThreshold());
        stalenessThreshold = _stalenessThreshold;
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
        if (isLong) {
            return (bet.longCollateral * PRECISION) / bet.longGameTokens;
        } else {
            return (bet.shortCollateral * PRECISION) / bet.shortGameTokens;
        }
    }
}
