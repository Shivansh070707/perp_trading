require("@nomicfoundation/hardhat-ethers")
require("hardhat-deploy")
require("hardhat-deploy-ethers")
require("@nomicfoundation/hardhat-verify")
require("hardhat-contract-sizer")
require("@nomicfoundation/hardhat-verify")
require("hardhat-gas-reporter")
require("@openzeppelin/hardhat-upgrades")
require("@nomicfoundation/hardhat-chai-matchers")
require('solidity-coverage')
require("dotenv").config()

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners()
  for (const account of accounts) {
    console.log(account.address)
  }
})

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const accounts = {
  mnemonic: process.env.MNEMONIC || "test test test test test test test test test test test junk",
  // accountsBalance: "990000000000000000000",
}

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  defaultNetwork: "hardhat",
  gasReporter: {
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    L1: "polygon",
    currency: "USD",
    enabled: true,
    outputFile: 'gas-report.csv', // Specify the output file (CSV format)
    noColors: true,             // Disable colors for easier parsing
    outputStyle: 'csv',
    baseFee: 30,
    showInternalFunctions: true,
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
    dev: {
      default: 1,
    },
    proxyAdminOwner: {
      default: 0,
    }
  },
  networks: {
    hardhat: {
      hardfork: "london",
      saveDeployments: true,
      allowUnlimitedContractSize: true,
      evmVersion: "byzantium",
      forking: {
        url: `https://arbitrum-sepolia.infura.io/v3/${process.env.INFURA_KEY}`,
        saveDeployments: true,
      },
      gasPrice: "auto",
      accounts,

    },
    'arbitrum-sepolia': {
      url: `https://sepolia-arbitrum.infura.io/v3/${process.env.INFURA_KEY}`,
      chainId: 421614,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY, process.env.PLAYER1_PRIVATE_KEY],
      gasPrice: "auto",
      live: true,
      saveDeployments: true,
    },
  },
  etherscan: {
    apiKey: process.env.API_KEY,
    customChains: [
      {
        network: 'arbitrum-sepolia',
        chainId: 421614,
        urls: {
          apiURL: "https://api-amoy.polygonscan.com/api",
          browserURL: "https://amoy.polygonscan.com/",
        },
      }
    ],
  },
  paths: {
    deploy: "deploy",
    deployments: "deployments",
    sources: "contracts",
    tests: "test",
  },
  mocha: {
    timeout: 300000,
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: true,
    runOnCompile: true
  },
  solidity: {
    compilers: [
      {
        version: "0.8.27",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          }
        },
      },
    ],
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
}
