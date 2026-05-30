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
    let user4;
    let getPrice;
    const ZERO_ADDRESS = ethers.ZeroAddress;
    const PRECISION = ethers.parseEther("1");
    const MIN_COLLATERAL = ethers.parseUnits("1", 6); // 1e6
    const pythAddress = '0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF'
    const BTC_FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'
    const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    const VALID_TIME_PERIOD = 60; // 60 seconds
    const UPDATE_FEE = 1; // 1 wei
    let updatePrice;
    const DEFAULT_STALENESS_THRESHOLD = 1800
    const duration = 86400;
    const depositPeriod = 18 * 60 * 60;



    beforeEach(async function () {
        [owner, user1, user2, user3, user4] = await ethers.getSigners();

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

        const VaultImplementation = await ethers.getContractFactory("MoonVault");
        const vaultImplementation = await VaultImplementation.deploy()

        // Deploy VaultFactory
        const VaultFactory = await ethers.getContractFactory("MoonVaultFactory");
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
        const Vault = await ethers.getContractFactory("MoonVault");
        vault = Vault.attach(vaultAddress);

        // Mint tokens to users
        const mintAmount = ethers.parseUnits("10000", 6);
        const usdcWhale = await ethers.getImpersonatedSigner("0x3931dAb967C3E2dbb492FE12460a66d0fe4cC857")

        await mockToken.connect(usdcWhale).transfer(owner.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user1.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user2.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user3.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user4.address, mintAmount);
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
            ).to.be.revertedWithCustomError(vaultFactory, "MVF_InvalidOracleAddress");
        });

        it("Should revert when creating vault with zero asset address", async function () {
            await expect(
                vaultFactory.createVault(pythOracle.target, BTC_FEED_ID, ZERO_ADDRESS)
            ).to.be.revertedWithCustomError(vaultFactory, "MVF_InvalidAssetAddress");
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
                ).to.be.revertedWithCustomError(vault, "MV_InvalidStalenessThreshold");
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

                await vault.createBet(duration, depositPeriod, 10000, 10000, initialLiquidity);
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
                const gameTokens = ethers.parseUnits("10000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await expect(vault.createBet(duration, depositPeriod, gameTokens, gameTokens, initialLiquidity))
                    .to.emit(vault, "BetCreated")
                    .withArgs(0, duration, Price);

                const bet = await vault.betDetails(0);
                expect(bet.initialAssetPrice).to.equal(Price);
                expect(bet.duration).to.equal(duration);
                expect(bet.depositPeriod).to.equal(depositPeriod);
                expect(bet.isOpen).to.be.true;
                expect(bet.longCollateral).to.equal(Number(initialLiquidity) / 2);
                expect(bet.shortCollateral).to.equal(Number(initialLiquidity) / 2);
                expect(bet.longGameTokens).to.equal(gameTokens);
                expect(bet.shortGameTokens).to.equal(gameTokens);

                const longGameTokenPrice = await vault.getGameTokenPrice(0, true)
                const shortGameTokenPrice = await vault.getGameTokenPrice(0, false)
                const PRECISION = await vault.PRECISION()
                expect(longGameTokenPrice).to.equal(PRECISION / 2n)
                expect(shortGameTokenPrice).to.equal(PRECISION / 2n)
            });

            it("Should revert when duration <= depositPeriod", async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await expect(
                    vault.createBet(3600, 3600, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(vault, "MV_InvalidDuration");
            });

            it("Should revert when oracle returns zero price", async function () {
                await updatePrice(0);
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await expect(
                    vault.createBet(86400, 3600, 10000, 10000, initialLiquidity)
                ).to.be.revertedWithCustomError(vault, "MV_InvalidOraclePrice");
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

                await vault.createBet(duration, depositPeriod, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);
                betId = 0;
                await mockToken.connect(user1).approve(vault.getAddress(), ethers.parseEther("1000"));
                await mockToken.connect(user2).approve(vault.getAddress(), ethers.parseEther("1000"));
            });

            it("Should place long position successfully", async function () {
                const collateral = ethers.parseUnits("1000", 6);
                const positionSize = ethers.parseUnits("5000", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, positionSize)
                )
                    .to.emit(vault, "PositionPlaced")
                    .withArgs(user1.address, betId, true, collateral, positionSize);

                const position = await vault.userPosition(user1.address, betId);
                expect(position.isLong).to.be.true;
                expect(position.collateral).to.equal(collateral);
                expect(position.positionSize).to.equal(positionSize);
                expect(position.gameTokens).to.equal(ethers.parseUnits("10000", 6));

                const bet = await vault.betDetails(0);
                expect(bet.longCollateral).to.equal(ethers.parseUnits("3500", 6));
                expect(bet.longGameTokens).to.equal(ethers.parseUnits("20000", 6));
                expect(bet.shortGameTokens).to.equal(ethers.parseUnits("10000", 6));

                const longGameTokenPrice = await vault.getGameTokenPrice(0, true)
                const shortGameTokenPrice = await vault.getGameTokenPrice(0, false)
                const PRECISION = await vault.PRECISION()
                expect(longGameTokenPrice).to.equal(2n * PRECISION / 3n)
                expect(shortGameTokenPrice).to.equal(PRECISION / 3n)
            });

            it("Should place short position successfully", async function () {
                const collateral = ethers.parseUnits("1000", 6);
                const positionSize = ethers.parseUnits("5000", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, false, collateral, positionSize)
                )
                    .to.emit(vault, "PositionPlaced")
                    .withArgs(user1.address, betId, false, collateral, positionSize);

                const position = await vault.userPosition(user1.address, betId);
                expect(position.isLong).to.be.false;
                expect(position.collateral).to.equal(collateral);
                expect(position.positionSize).to.equal(positionSize);
                expect(position.gameTokens).to.equal(ethers.parseUnits("10000", 6));

                const bet = await vault.betDetails(0);
                expect(bet.shortCollateral).to.equal(ethers.parseUnits("3500", 6));
                expect(bet.shortGameTokens).to.equal(ethers.parseUnits("20000", 6));
                expect(bet.longGameTokens).to.equal(ethers.parseUnits("10000", 6));

                const longGameTokenPrice = await vault.getGameTokenPrice(0, true)
                const shortGameTokenPrice = await vault.getGameTokenPrice(0, false)
                const PRECISION = await vault.PRECISION()
                expect(shortGameTokenPrice).to.equal(2n * PRECISION / 3n)
                expect(longGameTokenPrice).to.equal(PRECISION / 3n)
            });

            it("Should revert with invalid bet ID", async function () {
                await expect(
                    vault.connect(user1).placeBet(999, true, ethers.parseUnits("10", 6), ethers.parseUnits("20", 6))
                ).to.be.revertedWithCustomError(vault, "MV_BetNotOpen");
            });

            it("Should revert with insufficient collateral", async function () {
                const lowCollateral = ethers.parseUnits("0.9", 6); // Less than MIN_COLLATERAL
                const positionSize = ethers.parseUnits("20", 6);

                await expect(
                    vault.connect(user1).placeBet(betId, true, lowCollateral, positionSize)
                ).to.be.revertedWithCustomError(vault, "MV_CollateralTooLow");
            });

            it("Should revert when positionSize <= collateral", async function () {
                const collateral = ethers.parseUnits("10", 6);
                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, collateral)
                ).to.be.revertedWithCustomError(vault, "MV_InvalidPositionSize");
            });

            it("Should revert after deposit period ends", async function () {
                await time.increase(depositPeriod + 1);
                await expect(
                    vault.connect(user1).placeBet(betId, true, ethers.parseUnits("10", 6), ethers.parseUnits("20", 6))
                ).to.be.revertedWithCustomError(vault, "MV_DepositPeriodEnded");
            });
        });

        describe("Liquidation", function () {
            let betId;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);

                await vault.createBet(86400, 3600, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);
                betId = 0;
                await mockToken.connect(user1).approve(vault.target, ethers.parseEther("1000"));

                // Place a position with safe values
                const collateral = ethers.parseUnits("1000", 6);
                const positionSize = ethers.parseUnits("5000", 6);
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
                await updatePrice(799);

                await expect(vault.liquidatePosition(user1.address, betId))
                    .to.emit(vault, "PositionLiquidated")
                    .withArgs(user1.address, betId);

                const updatedPosition = await vault.userPosition(user1.address, betId);
                expect(updatedPosition.isLiquidated).to.be.true;
                expect(updatedPosition.positionSize).to.equal(0);
                expect(updatedPosition.gameTokens).to.equal(0);

                const bet = await vault.betDetails(0);
                expect(bet.longCollateral).to.equal(ethers.parseUnits("2500", 6));
                expect(bet.longGameTokens).to.equal(ethers.parseUnits("10000", 6));

                const liquidationCollateral = await vault.liquidationCollateral(0)
                expect(liquidationCollateral).to.equal(ethers.parseUnits("1000", 6));

                const longGameTokenPrice = await vault.getGameTokenPrice(0, true)
                const shortGameTokenPrice = await vault.getGameTokenPrice(0, false)
                const PRECISION = await vault.PRECISION()
                expect(longGameTokenPrice).to.equal(PRECISION / 2n)
                expect(shortGameTokenPrice).to.equal(PRECISION / 2n)
            });
        });

        describe("End Bet", function () {
            let betId;

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(86400, 3600, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);
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
                ).to.be.revertedWithCustomError(vault, "MV_BetDurationNotEnded");
            });

            it("Should revert when ending already closed bet", async function () {
                await time.increase(86401);
                await updatePrice(1100);
                await vault.endBet(betId);


                await expect(
                    vault.endBet(betId)
                ).to.be.revertedWithCustomError(vault, "MV_BetAlreadyClosed");
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
                await vault.createBet(86400, 3600, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);

                betId = 0;

                await mockToken.connect(user1).approve(vault.getAddress(), ethers.parseEther("1000"));
                await mockToken.connect(user2).approve(vault.getAddress(), ethers.parseEther("1000"));

                // Place positions
                await vault.connect(user1).placeBet(
                    betId,
                    true,
                    ethers.parseUnits("1000", 6),
                    ethers.parseUnits("5000", 6)
                );
                await vault.connect(user2).placeBet(
                    betId,
                    false,
                    ethers.parseUnits("1000", 6),
                    ethers.parseUnits("5000", 6)
                );

                // End bet
                await time.increase(86401);
                await updatePrice(1500);
                await vault.endBet(betId);
            });

            it("Should allow winner to claim rewards", async function () {
                // Set close price higher for long position win
                expect(await vault.connect(user1).claimRewards(betId)).to.changeTokenBalances(mockToken, [vault.target, user1.address], [-ethers.parseUnits("1000", 6), ethers.parseUnits("1000", 6)]);
                const updatedPosition = await vault.userPosition(user1.address, betId);
                expect(updatedPosition.isLiquidated).to.be.false;
                expect(updatedPosition.positionSize).to.equal(0);
                expect(updatedPosition.collateral).to.equal(0);
                expect(updatedPosition.gameTokens).to.equal(0);

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
                await vault.createBet(86400, 3600, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);
                await expect(
                    vault.connect(user1).claimRewards(2)
                ).to.be.revertedWithCustomError(vault, "MV_NoPositionFound");
            });
            it("Should revert when claiming multiple Times", async function () {
                await vault.connect(user1).claimRewards(betId);
                await expect(
                    vault.connect(user1).claimRewards(betId)
                ).to.be.revertedWithCustomError(vault, "MV_NoPositionFound");
            });
        })

        describe("Early Exit", function () {
            let betId;
            const duration = 86400; // 1 day
            const depositPeriod = 3600; // 1 hour

            beforeEach(async function () {
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(duration, depositPeriod, ethers.parseUnits("10000", 6), ethers.parseUnits("10000", 6), initialLiquidity);

                betId = 0;

                await mockToken.connect(user1).approve(vault.target, ethers.parseEther("1000"));

                // Place a long position
                await vault.connect(user1).placeBet(
                    betId,
                    true,
                    ethers.parseUnits("1000", 6),
                    ethers.parseUnits("5000", 6)
                );
            });

            it("Should allow early exit with partial game tokens", async function () {
                const initialPosition = await vault.userPosition(user1.address, betId);
                const exitGameTokens = initialPosition.gameTokens / 2n; // Half of game tokens
                const tx = await vault.connect(user1).earlyExit(betId, exitGameTokens);
                const receipt = await tx.wait();

                const position = await vault.userPosition(user1.address, betId);

                // Check position is updated correctly
                expect(position.gameTokens).to.equal(exitGameTokens);

                // Verify event is emitted
                const events = receipt.logs;
                const earlyExitEvent = events.find(
                    log => log.fragment && log.fragment.name === 'EarlyExit'
                );
                expect(earlyExitEvent).to.not.be.undefined;
            });

            it("Should calculate fee correctly based on time elapsed", async function () {
                const initialPosition = await vault.userPosition(user1.address, betId);
                const exitGameTokens = initialPosition.gameTokens / 2n; // Half of game tokens

                const bet = await vault.betDetails(betId);
                const position = await vault.userPosition(user1.address, betId);

                // Ensure all values are BigInt
                const timeElapsed = BigInt(await time.latest()) - bet.startTime;
                const betDuration = bet.duration;
                const feePercentage = (timeElapsed * 100n) / betDuration;

                const proportionalSize = (exitGameTokens * position.positionSize) / position.gameTokens;
                const proportionalCollateral = (proportionalSize * position.collateral) / position.positionSize;
                const expectedFee = (proportionalCollateral * feePercentage) / 100n;
                const expectedReturnAmount = proportionalCollateral - expectedFee;

                expect(await vault.connect(user1).earlyExit(betId, exitGameTokens)).to.changeTokenBalance(mockToken, user1.address, expectedReturnAmount);

                // Check liquidation collateral increased by fee
                const liquidationCollateral = await vault.liquidationCollateral(betId);
                expect(liquidationCollateral).to.equal(expectedFee);
            });

            it("Should revert when trying to exit with zero game tokens", async function () {
                await expect(
                    vault.connect(user1).earlyExit(betId, 0)
                ).to.be.revertedWithCustomError(vault, "MV_InvalidGameTokens");
            });

            it("Should revert when trying to exit more game tokens than position has", async function () {
                const position = await vault.userPosition(user1.address, betId);
                await expect(
                    vault.connect(user1).earlyExit(betId, position.gameTokens + 1n)
                ).to.be.revertedWithCustomError(vault, "MV_InvalidGameTokens");
            });

            it("Should update position correctly after partial early exit", async function () {
                const initialPosition = await vault.userPosition(user1.address, betId);
                const exitGameTokens = initialPosition.gameTokens / 2n; // Half of game tokens

                await vault.connect(user1).earlyExit(betId, exitGameTokens);

                const updatedPosition = await vault.userPosition(user1.address, betId);

                // Check position size and collateral are proportionally reduced
                const expectedProportionalSize = (exitGameTokens * initialPosition.positionSize) / initialPosition.gameTokens;
                const expectedProportionalCollateral = (expectedProportionalSize * initialPosition.collateral) / initialPosition.positionSize;

                expect(updatedPosition.positionSize).to.equal(initialPosition.positionSize - expectedProportionalSize);
                expect(updatedPosition.collateral).to.equal(initialPosition.collateral - expectedProportionalCollateral);
                expect(updatedPosition.gameTokens).to.equal(initialPosition.gameTokens - exitGameTokens);
            });
        });
        describe("Complete Lifecycle", function () {

            it("Full Lifecycle of Betting on BTC Price Movement", async () => {
                await updatePrice(69500);
                // Initial setup
                const initialLiquidity = ethers.parseUnits("5000", 6);
                await mockToken.connect(owner).approve(vault.target, initialLiquidity);
                await vault.createBet(
                    duration,
                    depositPeriod,
                    ethers.parseUnits("10000", 6),
                    ethers.parseUnits("10000", 6),
                    initialLiquidity
                );
                let bet = await vault.betDetails(0);
                expect(bet.initialAssetPrice).to.equal(ethers.parseEther("69500"));
                expect(bet.longCollateral).to.equal(ethers.parseUnits("2500", 6));
                expect(bet.shortCollateral).to.equal(ethers.parseUnits("2500", 6));
                expect(bet.longGameTokens).to.equal(ethers.parseUnits("10000", 6));
                expect(bet.shortGameTokens).to.equal(ethers.parseUnits("10000", 6));

                // User A buys 1000 USDC worth of LONG tokens
                const collateralA = ethers.parseUnits("1000", 6);
                const positionSizeA = ethers.parseUnits("5000", 6);
                await mockToken.connect(user1).approve(vault.target, collateralA);
                await vault.connect(user1).placeBet(0, true, collateralA, positionSizeA);
                let longGameTokenPrice = await vault.getGameTokenPrice(0, true);
                let shortGameTokenPrice = await vault.getGameTokenPrice(0, false);
                const PRECISION = await vault.PRECISION()
                expect(longGameTokenPrice).to.equal(2n * PRECISION / 3n)
                expect(shortGameTokenPrice).to.equal(PRECISION / 3n)
                bet = await vault.betDetails(0);
                expect(bet.longCollateral).to.equal(ethers.parseUnits("3500", 6));
                expect(bet.longGameTokens).to.equal(ethers.parseUnits("20000", 6));
                expect(bet.shortGameTokens).to.equal(ethers.parseUnits("10000", 6));
                expect(bet.shortCollateral).to.equal(ethers.parseUnits("2500", 6));

                // 4 hours pass, BTC price goes down to $69,320
                await time.increase(14400);
                await updatePrice(69320);

                // User B shorts with 500 USDC on 10x leverage
                const collateralB = ethers.parseUnits("500", 6);
                const positionSizeB = ethers.parseUnits("5000", 6);
                await mockToken.connect(user2).approve(vault.target, collateralB);
                await vault.connect(user2).placeBet(0, false, collateralB, positionSizeB);
                bet = await vault.betDetails(0);
                longGameTokenPrice = await vault.getGameTokenPrice(0, true);
                shortGameTokenPrice = await vault.getGameTokenPrice(0, false);
                let totalGameTokens = bet.shortGameTokens + bet.longGameTokens

                expect(bet.shortCollateral).to.equal(ethers.parseUnits("3000", 6));
                expect(bet.longCollateral).to.equal(ethers.parseUnits("3500", 6));
                expect(longGameTokenPrice).to.equal(bet.longGameTokens * PRECISION / totalGameTokens)
                expect(shortGameTokenPrice).to.equal(bet.shortGameTokens * PRECISION / totalGameTokens)

                // User A is afraid, sells his position
                const userPositionAbefore = await vault.userPosition(user1.address, 0);
                await vault.connect(user1).earlyExit(0, userPositionAbefore.gameTokens);
                const userPositionA = await vault.userPosition(user1.address, 0);
                expect(userPositionA.collateral).to.equal(0);
                expect(userPositionA.positionSize).to.equal(0);
                expect(userPositionA.gameTokens).to.equal(0);

                bet = await vault.betDetails(0);
                longGameTokenPrice = await vault.getGameTokenPrice(0, true);
                shortGameTokenPrice = await vault.getGameTokenPrice(0, false);
                totalGameTokens = bet.shortGameTokens + bet.longGameTokens

                expect(bet.shortCollateral).to.equal(ethers.parseUnits("3000", 6));
                expect(bet.longCollateral).to.equal(ethers.parseUnits("2500", 6));
                expect(longGameTokenPrice).to.equal(bet.longGameTokens * PRECISION / totalGameTokens)
                expect(shortGameTokenPrice).to.equal(bet.shortGameTokens * PRECISION / totalGameTokens)


                // 12 hours pass, price is now at $69,400
                await time.increase(43200);
                await updatePrice(69400);
                const collateralC = ethers.parseUnits("100", 6);
                const positionSizeC = ethers.parseUnits("2000", 6);
                await mockToken.connect(user3).approve(vault.target, collateralC);
                await vault.connect(user3).placeBet(0, true, collateralC, positionSizeC);
                const userPositionC = await vault.userPosition(user3.address, 0);
                expect(userPositionC.gameTokens).to.equal(ethers.parseUnits("7000", 6));


                //userD opens long
                const collateralD = ethers.parseUnits("100", 6);
                const positionSizeD = ethers.parseUnits("2000", 6);
                await mockToken.connect(user4).approve(vault.target, collateralD);
                await vault.connect(user4).placeBet(0, true, collateralD, positionSizeD);

                // Game concludes, BTC rallied to $69,710
                await time.increase(duration + 1);
                await updatePrice(69710);
                await vault.endBet(0);
                bet = await vault.betDetails(0);
                const liquidationCollateral = await vault.liquidationCollateral(0)


                expect(bet.closePrice).to.equal(ethers.parseEther("69710"));
                expect(bet.isOpen).to.be.false;

                // The LONG dudes won
                const userBalanceDBefore = await mockToken.balanceOf(user4.address);
                await vault.connect(user4).claimRewards(0);
                const userBalanceDAfter = await mockToken.balanceOf(user4.address);
                expect(userBalanceDAfter).to.be.gt(userBalanceDBefore);
            });
        })


    })
})
