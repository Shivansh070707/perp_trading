// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Vault.sol";

/**
 * @title VaultFactory
 * @dev Factory contract for deploying new Vault instances
 * @author Shivansh
 * @notice This contract allows the owner to deploy new Vault contracts with specified oracle and asset addresses
 */
contract VaultFactory is Ownable {
    /**
     * @dev Emitted when a new Vault is created
     * @param vaultAddress The address of the newly created Vault
     * @param oracle The address of the oracle used by the Vault
     * @param asset The address of the asset token used by the Vault
     */
    event VaultCreated(
        address indexed vaultAddress,
        address oracle,
        address asset
    );

    /// @dev Error thrown when oracle address is invalid
    error InvalidOracleAddress();
    
    /// @dev Error thrown when asset address is invalid
    error InvalidAssetAddress();

    /**
     * @dev Constructor that initializes the Ownable parent contract
     * @notice Sets the deployer as the initial owner
     */
    constructor() Ownable(msg.sender) {}

    /**
     * @notice Creates a new Vault instance
     * @dev Only callable by the contract owner
     * @param oracle The address of the oracle contract to be used by the new Vault
     * @param asset The address of the ERC20 token to be used as the asset in the new Vault
     * @return The address of the newly created Vault
     */
    function createVault(
        address oracle,
        address asset
    ) external onlyOwner returns (address) {
        if (oracle == address(0)) revert InvalidOracleAddress();
        if (asset == address(0)) revert InvalidAssetAddress();

        Vault newVault = new Vault(oracle, asset, msg.sender);
        emit VaultCreated(address(newVault), oracle, asset);
        return address(newVault);
    }
}