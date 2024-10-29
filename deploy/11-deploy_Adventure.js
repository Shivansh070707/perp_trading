// Defining bytecode and abi from original contract on mainnet to ensure bytecode matches and it produces the same pair code hash
const hre = require("hardhat");
require("dotenv").config()

module.exports = async function ({ getNamedAccounts, deployments }) {
    const { deploy } = deployments;
    const { deployer, proxyAdminOwner } = await getNamedAccounts();
    const owner = deployer
    const player = (await ethers.getContract("Player")).target;
    const slimeNFT = (await ethers.getContract("SlimeNFT")).target;
    const slimeCoins = await deploy("Adventure", {
        from: deployer,
        contract: "AdventureMode",
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
module.exports.tags = ["Adventure"]

