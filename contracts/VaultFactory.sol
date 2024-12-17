// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import {MoonVault} from "./MoonVault.sol";
import {IMoonVaultFactory} from "./interfaces/IMoonVaultFactory.sol";

/**
 * @title VaultFactory
 * @dev Factory contract for deploying new MoonVault instances
 * @author Shivansh
 * @notice This contract allows the owner to deploy new MoonVault contracts with specified oracle and asset addresses
 */
contract MoonVaultFactory is Ownable, IMoonVaultFactory {
    address public immutable vaultImplementation;

    /**
     * @dev Constructor that initializes the Ownable parent contract
     * @notice Sets the deployer as the initial owner
     */
    constructor(address _vaultImplementation) Ownable(msg.sender) {
        require(
            _vaultImplementation != address(0),
            MVF_InvalidImplementationAddress()
        );
        vaultImplementation = _vaultImplementation;
    }

    /**
     * @notice Creates a new MoonVault instance
     * @dev Only callable by the contract owner
     * @param _oracle The address of the oracle contract to be used by the new MoonVault
     * @param _assetId The address of the ERC20 token to be used as the asset in the new MoonVault
     * @return The address of the newly created MoonVault
     */
    function createVault(
        address _oracle,
        bytes32 _assetId,
        address _usdc
    ) external onlyOwner returns (address) {
        if (_oracle == address(0)) revert MVF_InvalidOracleAddress();
        if (_usdc == address(0)) revert MVF_InvalidAssetAddress();
        address newVault = Clones.clone(vaultImplementation);

        MoonVault(newVault).initialize(_oracle, _usdc, _assetId, msg.sender);
        emit VaultCreated(address(newVault), _oracle, _usdc);
        return address(newVault);
    }
}
