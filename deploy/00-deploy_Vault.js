// Defining bytecode and abi from original contract on mainnet to ensure bytecode matches and it produces the same pair code hash
const hre = require("hardhat");
require("dotenv").config()

module.exports = async function ({ getNamedAccounts, deployments }) {
    const { deploy } = deployments;
    const { deployer, proxyAdminOwner } = await getNamedAccounts();
    const owner = deployer

    const vault = await deploy("Vault", {
        from: deployer,
        contract: "Vault",
        log: true,
        deterministicDeployment: false,
        proxy: {
            execute: {
                init: {
                    methodName: "initialize",
                    args: [],
                },
            },
            proxyContract: "OpenZeppelinTransparentProxy",
        },
    });
};
module.exports.tags = ["Vault"]

