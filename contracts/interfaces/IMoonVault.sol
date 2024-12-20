// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IMoonVault
 * @dev Interface for the Vault contract managing betting positions
 */
interface IMoonVault {
    /**
     * @dev Struct containing details about a betting round
     * @param initialAssetPrice Initial asset price when bet was created
     * @param numPlayers Number of players in the bet
     * @param closeTime Timestamp when bet was closed
     * @param startTime Timestamp when bet started
     * @param duration Total duration of the bet
     * @param depositPeriod Period during which deposits are allowed
     * @param longGameTokens Total tokens for long positions
     * @param shortGameTokens Total tokens for short positions
     * @param longCollateral Total collateral in long positions
     * @param shortCollateral Total collateral in short positions
     * @param closePrice Final price when bet was closed
     * @param isOpen Whether the bet is still open
     */
    struct BetDetails {
        uint128 initialAssetPrice;
        uint128 closePrice;
        uint40 closeTime;
        uint40 startTime;
        uint40 duration;
        uint40 depositPeriod;
        bool isOpen;
        uint256 numPlayers;
        uint256 longGameTokens;
        uint256 shortGameTokens;
        uint256 longCollateral;
        uint256 shortCollateral;
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
        bool isLiquidated;
        uint40 entryTime;
        uint104 entryPrice;
        uint104 liquidationPrice;
        uint256 collateral;
        uint256 positionSize;
        uint256 gameTokens;
    }

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

    error MV_InvalidOracle();
    error MV_InvalidBetId();
    error MV_InvalidDuration();
    error MV_InvalidOraclePrice();
    error MV_CollateralTooLow();
    error MV_InvalidPositionSize();
    error MV_BetNotOpen();
    error MV_BetAlreadyClosed();
    error MV_DepositPeriodEnded();
    error MV_TransferFailed();
    error MV_NoPositionFound();
    error MV_AlreadyLiquidated();
    error MV_CannotLiquidate();
    error MV_BetDurationNotEnded();
    error MV_PositionAlreadyLiquidated();
    error MV_InvalidGameTokens();
    error MV_DepositsStillOpen();
    error MV_CannotRecoverVaultToken();
    error MV_InvalidStalenessThreshold();

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
    ) external;

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
    ) external;

    /**
     * @notice Liquidates a user's position
     * @param user Address of the user to liquidate
     * @param betId Identifier of the bet
     */
    function liquidatePosition(address user, uint256 betId) external;

    /**
     * @notice Ends a betting round
     * @dev Only callable by contract owner
     * @param betId Identifier of the bet to end
     */
    function endBet(uint256 betId) external;

    /**
     * @notice Claims rewards for a closed betting round
     * @param betId Identifier of the bet
     */
    function claimRewards(uint256 betId) external;

    /**
     * @notice Allows early exit from a position
     * @param betId Identifier of the bet
     * @param exitGameTokens Number of game tokens to exit with
     */
    function earlyExit(uint256 betId, uint256 exitGameTokens) external;

    /**
     * @notice Pauses the contract
     * @dev Only callable by contract owner
     */
    function pause() external;

    /**
     * @notice Unpauses the contract
     * @dev Only callable by contract owner
     */
    function unpause() external;

    /**
     * @notice Recovers ERC20 tokens accidentally sent to the contract
     * @dev Only callable by contract owner, cannot recover vault token
     * @param tokenAddress Address of the token to recover
     * @param amount Amount of tokens to recover
     */

    function recoverToken(address tokenAddress, uint256 amount) external;

    function setStalenessThreshold(uint256 _stalenessThreshold) external;

    function betDetails(
        uint256 betId
    ) external view returns (BetDetails memory);
    function userPosition(
        address user,
        uint256 betId
    ) external view returns (UserPosition memory);
    function liquidationCollateral(
        uint256 betId
    ) external view returns (uint256);
}
