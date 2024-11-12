const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Vault and VaultFactory Contracts", function () {
    let vaultFactory;
    let vault;
    let pythOracle;
    let mockToken;
    let owner;
    let user1;
    let user2;
    let user3;
    let getPrice;
    const ZERO_ADDRESS = ethers.ZeroAddress;
    const PRECISION = ethers.parseEther("1");
    const MIN_COLLATERAL = ethers.parseUnits("1", 6); // 1e6
    const pythAddress = '0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF'
    const BTC_FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'
    const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'
    const VALID_TIME_PERIOD = 60; // 60 seconds
    const UPDATE_FEE = 1; // 1 wei
    let updatePrice;
    const DEFAULT_STALENESS_THRESHOLD = 1800
    const duration = 86400;
    const depositPeriod = 3600;



    beforeEach(async function () {
        [owner, user1, user2, user3] = await ethers.getSigners();

        // Deploy mock contracts
        const PythOracle = await ethers.getContractFactory("MockPyth");
        pythOracle = await PythOracle.deploy(VALID_TIME_PERIOD, UPDATE_FEE)

        updatePrice = async (price) => {
            const block = await ethers.provider.getBlock('latest')
            const currentTime = block.timestamp
            const priceFeedData = await pythOracle.createPriceFeedUpdateData(
                BTC_FEED_ID,         // id
                price * 1e8,         // price (scaled by 1e8)
                100,                 // confidence
                -8,                  // exponent
                price * 1e8,         // emaPrice
                100,                 // emaConfidence
                currentTime,         // publishTime
                currentTime  // prevPublishTime
            );

            await pythOracle.updatePriceFeeds([priceFeedData], { value: UPDATE_FEE });
        }

        await updatePrice(1000);

        const MockToken = await ethers.getContractFactory("MockToken");
        mockToken = MockToken.attach(USDC)

        const VaultImplementation = await ethers.getContractFactory("Vault");
        const vaultImplementation = await VaultImplementation.deploy()

        // Deploy VaultFactory
        const VaultFactory = await ethers.getContractFactory("VaultFactory");
        vaultFactory = await VaultFactory.deploy(vaultImplementation.target);

        // Create new Vault instance
        const tx = await vaultFactory.createVault(
            pythOracle.target,
            BTC_FEED_ID,
            USDC
        );
        const receipt = await tx.wait();
        const vaultCreatedEvent = receipt.logs.find(
            log => {
                try {
                    const decoded = vaultFactory.interface.parseLog(log);
                    return decoded?.name === 'VaultCreated';
                } catch {
                    return false;
                }
            }
        );

        if (!vaultCreatedEvent) {
            throw new Error("VaultCreated event not found");
        }

        const decoded = vaultFactory.interface.parseLog(vaultCreatedEvent);
        const vaultAddress = decoded.args[0];

        // Get Vault instance
        const Vault = await ethers.getContractFactory("Vault");
        vault = Vault.attach(vaultAddress);

        // Mint tokens to users
        const mintAmount = ethers.parseUnits("10000", 6);
        const usdcWhale = await ethers.getImpersonatedSigner("0x6ED0C4ADDC308bb800096B8DaA41DE5ae219cd36")

        await mockToken.connect(usdcWhale).transfer(owner.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user1.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user2.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user3.address, mintAmount);
        getPrice = async () => {
            const priceFeed = await pythOracle.queryPriceFeed(BTC_FEED_ID);
            const price = priceFeed.price.price;
            const expo = priceFeed.price.expo;
            return BigInt(price) * (BigInt(10) ** BigInt(18 + Number(expo)));
        };

    });

    describe("VaultFactory", function () {
        it("Should deploy factory with correct owner", async function () {
            expect(await vaultFactory.owner()).to.equal(owner.address);
        });

        it("Should revert when creating vault with zero oracle address", async function () {
            await expect(
                vaultFactory.createVault(ZERO_ADDRESS, BTC_FEED_ID, USDC)
            ).to.be.revertedWithCustomError(vaultFactory, "InvalidOracleAddress");
        });

        it("Should revert when creating vault with zero asset address", async function () {
            await expect(
                vaultFactory.createVault(pythOracle.target, BTC_FEED_ID, ZERO_ADDRESS)
            ).to.be.revertedWithCustomError(vaultFactory, "InvalidAssetAddress");
        });

        it("Should emit VaultCreated event", async function () {
            const tx = await vaultFactory.createVault(
                pythOracle.target,
                BTC_FEED_ID,
                USDC
            );

            const receipt = await tx.wait();
            const vaultCreatedEvent = receipt.logs.find(
                log => {
                    try {
                        const decoded = vaultFactory.interface.parseLog(log);
                        return decoded?.name === 'VaultCreated';
                    } catch {
                        return false;
                    }
                }
            );

            if (!vaultCreatedEvent) {
                throw new Error("VaultCreated event not found");
            }

            const decoded = vaultFactory.interface.parseLog(vaultCreatedEvent);
            expect(decoded).to.not.be.undefined;
            expect(decoded.args[1]).to.equal(pythOracle.target);
            expect(decoded.args[2]).to.equal(USDC);
        });
    });

    describe("Vault", function () {
        describe("Deployment", function () {
            it("Should set the right owner", async function () {
                expect(await vault.owner()).to.equal(owner.address);
            });

            it("Should initialize with correct MIN_COLLATERAL", async function () {
                expect(await vault.MIN_COLLATERAL()).to.equal(MIN_COLLATERAL);
            });

            it("Should initialize with correct PRECISION", async function () {
                expect(await vault.PRECISION()).to.equal(PRECISION);
            });
        });
        describe("Staleness Threshold", function () {
            it("Should initialize with correct staleness threshold", async function () {
                expect(await vault.stalenessThreshold()).to.equal(DEFAULT_STALENESS_THRESHOLD);
            });

            it("Should allow owner to update staleness threshold", async function () {
                const newThreshold = 120; // 2 minutes
                await vault.setStalenessThreshold(newThreshold);
                expect(await vault.stalenessThreshold()).to.equal(newThreshold);
            });

            it("Should revert when setting staleness threshold to zero", async function () {
                await expect(
                    vault.setStalenessThreshold(0)
                ).to.be.revertedWithCustomError(vault, "InvalidStalenessThreshold");
            });

            it("Should revert when non-owner tries to update staleness threshold", async function () {
                await expect(
                    vault.connect(user1).setStalenessThreshold(120)
                ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            });
        });
        describe("Price Updates", function () {
            it("Should get valid price using getPriceNoOlderThan", async function () {
                const price = await getPrice();
                expect(price).to.not.equal(0);
                expect(price).to.equal(ethers.parseEther("1000"));
            });

            it("Should revert when price is too old", async function () {
                await updatePrice(1000);
                const stalenessThreshold = await vault.stalenessThreshold();
                await time.increase(Number(stalenessThreshold) + 1);
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
  
                await expect(
                    vault.createBet(duration, depositPeriod, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(
                    pythOracle,
                    "StalePrice"
                );
            });

            it("Should handle price updates within staleness threshold", async function () {

                await updatePrice(1000);
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
         
                await vault.createBet(duration, depositPeriod ,10000, 10000, initialLiquidity);
                betId = 0;
                const stalenessThreshold = await vault.stalenessThreshold();

                await time.increase(Number(stalenessThreshold) - 10);
                const collateral = ethers.parseUnits("100", 6);
                const positionSize = ethers.parseUnits("1000", 6);

                await mockToken.connect(user1).approve(vault.target, collateral);
                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, positionSize)
                ).to.not.be.reverted;
            });

            it("Should handle price updates with modified staleness threshold", async function () {
                const newThreshold = 120;
                await vault.setStalenessThreshold(newThreshold);

                await updatePrice(1000);
                await time.increase(90);
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await expect(
                    vault.createBet(duration, depositPeriod, 10000, 10000, initialLiquidity)
                ).to.not.be.reverted;
            });
        });

        describe("Bet Creation", function () {
            it("Should create bet with valid parameters", async function () {
                const Price = await getPrice()
                const duration = 86400; // 1 day
                const depositPeriod = 3600; // 1 hour
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await expect(vault.createBet(duration, depositPeriod, 10000, 10000, initialLiquidity))
                    .to.emit(vault, "BetCreated")
                    .withArgs(0, duration, Price);

                const bet = await vault.betDetails(0);
                expect(bet.initialAssetPrice).to.equal(Price);
                expect(bet.duration).to.equal(duration);
                expect(bet.depositPeriod).to.equal(depositPeriod);
                expect(bet.isOpen).to.be.true;
            });

            it("Should revert when duration <= depositPeriod", async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
               
                await expect(
                    vault.createBet(3600, 3600, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(vault, "InvalidDuration");
            });

            it("Should revert when oracle returns zero price", async function () {
                await updatePrice(0);
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
             
                await expect(
                    vault.createBet(86400, 3600, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(vault, "InvalidOraclePrice");
            });

            it("Should revert when called by non-owner", async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
            
                await expect(
                    vault.connect(user1).createBet(86400, 3600, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            });
        });

        describe("Place Bet", function () {
            let betId;
            const duration = 86400;
            const depositPeriod = 3600;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                
                await vault.createBet(duration, depositPeriod, 10000, 10000, initialLiquidity);
                betId = 0;
                await mockToken.connect(user1).approve(vault.getAddress(), ethers.parseEther("1000"));
                await mockToken.connect(user2).approve(vault.getAddress(), ethers.parseEther("1000"));
            });

            it("Should place long position successfully", async function () {
                const collateral = ethers.parseUnits("100", 6);
                const positionSize = ethers.parseUnits("1000", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, positionSize)
                )
                    .to.emit(vault, "PositionPlaced")
                    .withArgs(user1.address, betId, true, collateral, positionSize);

                const position = await vault.userPosition(user1.address, betId);
                expect(position.isLong).to.be.true;
                expect(position.collateral).to.equal(collateral);
                expect(position.positionSize).to.equal(positionSize);
            });

            it("Should place short position successfully", async function () {
                const collateral = ethers.parseUnits("10", 6);
                const positionSize = ethers.parseUnits("20", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, false, collateral, positionSize)
                )
                    .to.emit(vault, "PositionPlaced")
                    .withArgs(user1.address, betId, false, collateral, positionSize);

                const position = await vault.userPosition(user1.address, betId);
                expect(position.isLong).to.be.false;
            });

            it("Should revert with invalid bet ID", async function () {
                await expect(
                    vault.connect(user1).placeBet(999, true, ethers.parseUnits("10", 6), ethers.parseUnits("20", 6))
                ).to.be.revertedWithCustomError(vault, "NoPositionFound");
            });

            it("Should revert with insufficient collateral", async function () {
                const lowCollateral = ethers.parseUnits("0.9", 6); // Less than MIN_COLLATERAL
                const positionSize = ethers.parseUnits("20", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, true, lowCollateral, positionSize)
                ).to.be.revertedWithCustomError(vault, "CollateralTooLow");
            });

            it("Should revert when positionSize <= collateral", async function () {
                const collateral = ethers.parseUnits("10", 6);
                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, collateral)
                ).to.be.revertedWithCustomError(vault, "InvalidPositionSize");
            });

            it("Should revert after deposit period ends", async function () {
                await time.increase(depositPeriod + 1);
                await expect(
                    vault.connect(user1).placeBet(betId, true, ethers.parseUnits("10", 6), ethers.parseUnits("20", 6))
                ).to.be.revertedWithCustomError(vault, "DepositPeriodEnded");
            });
        });

        describe("Liquidation", function () {
            let betId;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                
                await vault.createBet(86400, 3600, 10000, 10000, initialLiquidity);
                betId = 0;
                await mockToken.connect(user1).approve(vault.target, ethers.parseEther("1000"));

                // Place a position with safe values
                const collateral = ethers.parseUnits("100", 6);
                const positionSize = ethers.parseUnits("1000", 6);
                await vault.connect(user1).placeBet(
                    betId,
                    true,
                    collateral,
                    positionSize
                );
            });

            it("Should liquidate long position when price drops below liquidation price", async function () {
                const position = await vault.userPosition(user1.address, betId);

                // Set price below liquidation price
                await updatePrice(899);

                await expect(vault.liquidatePosition(user1.address, betId))
                    .to.emit(vault, "PositionLiquidated")
                    .withArgs(user1.address, betId);

                const updatedPosition = await vault.userPosition(user1.address, betId);
                expect(updatedPosition.isLiquidated).to.be.true;
                expect(updatedPosition.positionSize).to.equal(0);
            });
        });

        describe("End Bet", function () {
            let betId;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(86400, 3600, 10000, 10000, initialLiquidity);
                betId = 0;
            });

            it("Should end bet successfully after duration", async function () {
                await time.increase(86401);
                const closePrice = 1100;
                await updatePrice(closePrice);

                await vault.endBet(betId)
                const bet = await vault.betDetails(betId);
                expect(bet.isOpen).to.be.false;
            });

            it("Should revert when ending bet before duration", async function () {
                await expect(
                    vault.endBet(betId)
                ).to.be.revertedWithCustomError(vault, "BetDurationNotEnded");
            });

            it("Should revert when ending already closed bet", async function () {
                await time.increase(86401);
                await updatePrice(1100);
                await vault.endBet(betId);


                await expect(
                    vault.endBet(betId)
                ).to.be.revertedWithCustomError(vault, "BetAlreadyClosed");
            });

            it("Should revert when called by non-owner", async function () {
                await time.increase(86401);
                await expect(
                    vault.connect(user1).endBet(betId)
                ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            });
        });

        describe("Claim Rewards", function () {
            let betId;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(86400, 3600, 10000, 10000, initialLiquidity);
            
                betId = 0;

                await mockToken.connect(user1).approve(vault.getAddress(), ethers.parseEther("1000"));
                await mockToken.connect(user2).approve(vault.getAddress(), ethers.parseEther("1000"));

                // Place positions
                await vault.connect(user1).placeBet(
                    betId,
                    true,
                    ethers.parseUnits("10", 6),
                    ethers.parseUnits("20", 6)
                );
                await vault.connect(user2).placeBet(
                    betId,
                    false,
                    ethers.parseUnits("10", 6),
                    ethers.parseUnits("20", 6)
                );

                // End bet
                await time.increase(86401);
                await updatePrice(1500);
                await vault.endBet(betId);
            });

            it("Should allow winner to claim rewards", async function () {
                // Set close price higher for long position win

                const initialBalance = await mockToken.balanceOf(user1.address);
                await vault.connect(user1).claimRewards(betId);
                const finalBalance = await mockToken.balanceOf(user1.address);
                expect(finalBalance).to.be.gt(initialBalance);
            });

            it("Should not allow loser to claim rewards", async function () {
                // Set close price higher for long position win
                await updatePrice(1500);

                const initialBalance = await mockToken.balanceOf(user2.address);
                await vault.connect(user2).claimRewards(betId);
                const finalBalance = await mockToken.balanceOf(user2.address);

                expect(finalBalance).to.equal(initialBalance);
            });

            it("Should revert when claiming from open bet", async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(86400, 3600, 10000, 10000, initialLiquidity);
                await expect(
                    vault.connect(user1).claimRewards(2)
                ).to.be.revertedWithCustomError(vault, "NoPositionFound");
            });
        })
    })
})