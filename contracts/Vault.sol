// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IOracle.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Vault
 * @dev A smart contract for managing betting positions on asset prices
 * @author Shivansh
 * @notice This contract allows users to take long or short positions on asset prices
 */
contract Vault is Ownable, ReentrancyGuard, Pausable {
    uint256 count;
    IERC20 asset;
    IOracle oracle;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_COLLATERAL = 1e6;

    /**
     * @dev Struct containing details about a betting round
     * @param assetPrice Initial asset price when bet was created
     * @param numPlayers Number of players in the bet
     * @param closeTime Timestamp when bet was closed
     * @param startTime Timestamp when bet started
     * @param duration Total duration of the bet
     * @param depositPeriod Period during which deposits are allowed
     * @param totalLongTokens Total tokens for long positions
     * @param totalShortTokens Total tokens for short positions
     * @param longCollateral Total collateral in long positions
     * @param shortCollateral Total collateral in short positions
     * @param closePrice Final price when bet was closed
     * @param isOpen Whether the bet is still open
     */
    struct BetDetails {
        uint256 assetPrice;
        uint256 numPlayers;
        uint256 closeTime;
        uint256 startTime;
        uint256 duration;
        uint256 depositPeriod;
        uint256 totalLongTokens;
        uint256 totalShortTokens;
        uint256 longCollateral;
        uint256 shortCollateral;
        uint256 closePrice;
        bool isOpen;
    }

    /**
     * @dev Struct containing details about a user's position
     * @param isLong Whether position is long (true) or short (false)
     * @param collateral Amount of collateral deposited
     * @param positionSize Size of the position
     * @param entryPrice Price at position entry
     * @param liquidationPrice Price at which position gets liquidated
     * @param isLiquidated Whether position has been liquidated
     * @param entryTime Timestamp of position entry
     * @param gameTokens Number of game tokens received
     */
    struct UserPosition {
        bool isLong;
        uint256 collateral;
        uint256 positionSize;
        uint256 entryPrice;
        uint256 liquidationPrice;
        bool isLiquidated;
        uint256 entryTime;
        uint256 gameTokens;
    }

    mapping(uint256 => BetDetails) public _betDetails;
    mapping(address => mapping(uint256 => UserPosition)) public userPosition;
    mapping(uint256 => uint256) public liquidationCollateral;

    /**
     * @dev Emitted when a new bet is created
     * @param betId Identifier of the bet
     * @param duration Duration of the bet
     * @param assetPrice Initial asset price
     */
    event BetCreated(
        uint256 indexed betId,
        uint256 duration,
        uint256 assetPrice
    );

    /**
     * @dev Emitted when a position is placed
     * @param user Address of the user
     * @param betId Identifier of the bet
     * @param isLong Whether position is long
     * @param collateral Amount of collateral
     * @param positionSize Size of position
     */
    event PositionPlaced(
        address indexed user,
        uint256 indexed betId,
        bool isLong,
        uint256 collateral,
        uint256 positionSize
    );

    /**
     * @dev Emitted when a position is liquidated
     * @param user Address of the liquidated user
     * @param betId Identifier of the bet
     */
    event PositionLiquidated(address indexed user, uint256 indexed betId);

    /**
     * @dev Emitted when a bet ends
     * @param betId Identifier of the bet
     * @param closePrice Final price at bet closure
     */
    event BetEnded(uint256 indexed betId, uint256 closePrice);

    /**
     * @dev Emitted when rewards are claimed
     * @param user Address of the user claiming rewards
     * @param betId Identifier of the bet
     * @param amount Amount of rewards claimed
     */
    event RewardsClaimed(
        address indexed user,
        uint256 indexed betId,
        uint256 amount
    );

    /**
     * @dev Emitted when a user exits early
     * @param user Address of the user
     * @param betId Identifier of the bet
     * @param amount Amount returned to user
     */
    event EarlyExit(
        address indexed user,
        uint256 indexed betId,
        uint256 amount
    );

    error InvalidOracle();
    error InvalidBetId();
    error InvalidDuration();
    error InvalidOraclePrice();
    error CollateralTooLow();
    error InvalidPositionSize();
    error BetNotOpen();
    error BetAlreadyClosed();
    error DepositPeriodEnded();
    error TransferFailed();
    error NoPositionFound();
    error AlreadyLiquidated();
    error CannotLiquidate();
    error BetDurationNotEnded();
    error PositionAlreadyLiquidated();
    error InvalidGameTokens();
    error DepositsStillOpen();
    error CannotRecoverVaultToken();

    /**
     * @dev Contract constructor
     * @param _oracle Address of the oracle contract
     * @param _asset Address of the asset token contract
     * @param initialOwner Address of the initial contract owner
     */
    constructor(
        address _oracle,
        address _asset,
        address initialOwner
    ) Ownable(initialOwner) {
        require(_oracle != address(0), InvalidOracle());
        oracle = IOracle(_oracle);
        asset = IERC20(_asset);
    }

    /**
     * @dev Modifier to check if bet exists
     * @param betId Identifier of the bet to check
     */
    modifier betExists(uint256 betId) {
        require(betId != 0 && betId <= count, InvalidBetId());
        _;
    }

    /**
     * @notice Creates a new betting round
     * @dev Only callable by contract owner
     * @param duration Total duration of the bet
     * @param depositPeriod Period during which deposits are allowed
     */
    function createBet(
        uint256 duration,
        uint256 depositPeriod
    ) external onlyOwner {
        require(duration > depositPeriod, InvalidDuration());

        uint256 currentPrice = oracle.getPrice();
        require(currentPrice != 0, InvalidOraclePrice());

        count++;

        _betDetails[count] = BetDetails({
            assetPrice: currentPrice,
            numPlayers: 0,
            isOpen: true,
            closePrice: 0,
            closeTime: 0,
            startTime: block.timestamp,
            duration: duration,
            totalLongTokens: 0,
            totalShortTokens: 0,
            longCollateral: 0,
            shortCollateral: 0,
            depositPeriod: depositPeriod
        });

        emit BetCreated(count, duration, currentPrice);
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
    ) external nonReentrant betExists(betId) whenNotPaused {
        require(collateral >= MIN_COLLATERAL, CollateralTooLow());
        require(positionSize > collateral, InvalidPositionSize());

        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, BetNotOpen());
        require(
            block.timestamp <= bet.startTime + bet.depositPeriod,
            DepositPeriodEnded()
        );

        uint256 currentPrice = oracle.getPrice();
        require(currentPrice != 0, InvalidOraclePrice());

        uint256 liquidationPrice;
        if (isLong) {
            liquidationPrice = (currentPrice *
                (1 - ((collateral) / positionSize)));
        } else {
            liquidationPrice = (currentPrice *
                (1 + ((collateral) / positionSize)));
        }

        require(
            asset.transferFrom(msg.sender, address(this), collateral),
            TransferFailed()
        );

        uint256 gameTokenPrice = 1;
        uint256 gameTokens = (positionSize ) / gameTokenPrice;

        UserPosition storage position = userPosition[msg.sender][betId];
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
            bet.totalLongTokens += gameTokens;
        } else {
            bet.shortCollateral += collateral;
            bet.totalShortTokens += gameTokens;
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
    ) external nonReentrant betExists(betId) {
        UserPosition storage position = userPosition[user][betId];
        require(position.collateral != 0, NoPositionFound());
        require(!position.isLiquidated, AlreadyLiquidated());

        uint256 currentPrice = oracle.getPrice();
        require(currentPrice != 0, InvalidOraclePrice());

        bool shouldLiquidate = position.isLong
            ? currentPrice <= position.liquidationPrice
            : currentPrice >= position.liquidationPrice;

        require(shouldLiquidate, CannotLiquidate());

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
    function endBet(
        uint256 betId
    ) external onlyOwner betExists(betId) whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(bet.isOpen, BetAlreadyClosed());
        require(
            block.timestamp >= bet.startTime + bet.duration,
            BetDurationNotEnded()
        );

        uint256 currentPrice = oracle.getPrice();
        require(currentPrice != 0, InvalidOraclePrice());

        bet.closePrice = currentPrice;
        bet.closeTime = block.timestamp;
        bet.isOpen = false;

        emit BetEnded(betId, currentPrice);
    }

    /**
     * @notice Claims rewards for a closed betting round
     * @param betId Identifier of the bet
     */
    function claimRewards(
        uint256 betId
    ) external nonReentrant betExists(betId) whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(!bet.isOpen, BetNotOpen());

        UserPosition storage position = userPosition[msg.sender][betId];
        require(!position.isLiquidated, PositionAlreadyLiquidated());
        require(position.collateral != 0, NoPositionFound());

        bool isLongWinner = bet.closePrice > bet.assetPrice;
        bool isWinner = position.isLong == isLongWinner;

        uint256 totalCollateral = position.isLong
            ? bet.shortCollateral + liquidationCollateral[betId]
            : bet.longCollateral + liquidationCollateral[betId];

        uint256 userShare;
        if (isWinner) {
            uint256 winningCollateral = position.isLong
                ? bet.longCollateral
                : bet.shortCollateral;

            userShare =
                (position.collateral * totalCollateral) /
                winningCollateral;
        }

        position.collateral = 0;
        position.positionSize = 0;
        position.gameTokens = 0;

        if (userShare > 0) {
            require(asset.transfer(msg.sender, userShare), TransferFailed());
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
    ) external nonReentrant betExists(betId) whenNotPaused {
        BetDetails storage bet = _betDetails[betId];
        require(!bet.isOpen, DepositsStillOpen());

        UserPosition storage position = userPosition[msg.sender][betId];
        require(
            exitGameTokens != 0 && exitGameTokens <= position.gameTokens,
            InvalidGameTokens()
        );

        uint256 proportionalSize = (exitGameTokens * position.positionSize) /
            position.gameTokens;
        uint256 proportionalCollateral = (proportionalSize *
            position.collateral) / position.positionSize;

        uint256 timeElapsed = block.timestamp - bet.startTime;
        uint256 fee = (timeElapsed * proportionalCollateral) / bet.duration;
        uint256 returnAmount = proportionalCollateral - fee;

        position.positionSize -= proportionalSize;
        position.collateral -= proportionalCollateral;
        position.gameTokens -= exitGameTokens;

        liquidationCollateral[betId] += fee;

        require(asset.transfer(msg.sender, returnAmount), TransferFailed());

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

    /**
     * @notice Recovers ERC20 tokens accidentally sent to the contract
     * @dev Only callable by contract owner, cannot recover vault token
     * @param tokenAddress Address of the token to recover
     * @param amount Amount of tokens to recover
     */
    function recoverToken(
        address tokenAddress,
        uint256 amount
    ) external onlyOwner {
        require(tokenAddress != address(asset), CannotRecoverVaultToken());
        require(
            IERC20(tokenAddress).transfer(owner(), amount),
            TransferFailed()
        );
    }
}
