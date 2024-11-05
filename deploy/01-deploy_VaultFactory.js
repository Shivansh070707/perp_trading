// Defining bytecode and abi from original contract on mainnet to ensure bytecode matches and it produces the same pair code hash
const hre = require("hardhat");
require("dotenv").config()

module.exports = async function ({ getNamedAccounts, deployments }) {
    const { deploy } = deployments;
    const { deployer, proxyAdminOwner } = await getNamedAccounts();
    const owner = deployer

    const vaultFactory = await deploy("VaultFactory", {
        from: deployer,
        contract: "VaultFactory",
        log: true,
        deterministicDeployment: false,
        proxy: {
            execute: {
                init: {
                    methodName: "initialize",
                    args: [slimeNFT,player],
                },
            },
            proxyContract: "OpenZeppelinTransparentProxy",
        },
    });
};
module.exports.tags = ["VaultFactory"]

