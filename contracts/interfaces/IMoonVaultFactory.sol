// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

/**
 * @title IMoonVaultFactory
 * @dev Interface for the VaultFactory contract
 * @author Shivansh
 * @notice Defines the interface for creating new MoonVault instances
 */
interface IMoonVaultFactory {
    /**
     * @dev Emitted when a new MoonVault is created
     * @param vaultAddress The address of the newly created MoonVault
     * @param oracle The address of the oracle used by the MoonVault
     * @param asset The address of the asset token used by the MoonVault
     */
    event VaultCreated(
        address indexed vaultAddress,
        address oracle,
        address asset
    );

    /// @dev Error thrown when oracle address is invalid
    error MVF_InvalidOracleAddress();

    /// @dev Error thrown when asset address is invalid
    error MVF_InvalidAssetAddress();

    /// @dev Error thrown when implementation address is invalid
    error MVF_InvalidImplementationAddress();

    /**
     * @notice Creates a new MoonVault instance
     * @dev Only callable by the contract owner
     * @param _oracle The address of the oracle contract to be used by the new MoonVault
     * @param _assetId The identifier for the asset to be used in the new MoonVault
     * @param _usdc The address of the USDC token to be used as the asset in the new MoonVault
     * @return The address of the newly created MoonVault
     */
    function createVault(
        address _oracle,
        bytes32 _assetId,
        address _usdc
    ) external returns (address);

    /**
     * @notice Returns the address of the vault implementation used for cloning
     * @return The address of the vault implementation contract
     */
    function vaultImplementation() external view returns (address);
}
