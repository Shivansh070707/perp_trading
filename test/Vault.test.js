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

    beforeEach(async function () {
        [owner, user1, user2, user3] = await ethers.getSigners();

        // Deploy mock contracts
        const PythOracle = await ethers.getContractFactory("MockPyth");
        pythOracle = await PythOracle.deploy()

        await pythOracle.setPrice(BTC_FEED_ID, 1000);

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

        await mockToken.connect(usdcWhale).transfer(user1.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user2.address, mintAmount);
        await mockToken.connect(usdcWhale).transfer(user3.address, mintAmount);
        getPrice = async () => {
            const retrievedPrice = await pythOracle.getPriceUnsafe(BTC_FEED_ID);

            // Explicitly convert to BigInt
            const priceBigInt = BigInt(retrievedPrice.price);
            const exponent = BigInt(18 + Number(retrievedPrice.expo));

            // Calculate price with BigInt math
            const baseConversion = BigInt(10) ** exponent;
            return priceBigInt * baseConversion;
        }

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

        describe("Bet Creation", function () {
            it("Should create bet with valid parameters", async function () {
                const Price = await getPrice()
                const duration = 86400; // 1 day
                const depositPeriod = 3600; // 1 hour

                await expect(vault.createBet(duration, depositPeriod))
                    .to.emit(vault, "BetCreated")
                    .withArgs(1, duration, Price);

                const bet = await vault.betDetails(1);
                expect(bet.assetPrice).to.equal(Price);
                expect(bet.duration).to.equal(duration);
                expect(bet.depositPeriod).to.equal(depositPeriod);
                expect(bet.isOpen).to.be.true;
            });

            it("Should revert when duration <= depositPeriod", async function () {
                await expect(
                    vault.createBet(3600, 3600)
                ).to.be.revertedWithCustomError(vault, "InvalidDuration");
            });

            it("Should revert when oracle returns zero price", async function () {
                await pythOracle.setPrice(BTC_FEED_ID, 0);
                await expect(
                    vault.createBet(86400, 3600)
                ).to.be.revertedWithCustomError(vault, "InvalidOraclePrice");
            });

            it("Should revert when called by non-owner", async function () {
                await expect(
                    vault.connect(user1).createBet(86400, 3600)
                ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            });
        });

        describe("Place Bet", function () {
            let betId;
            const duration = 86400;
            const depositPeriod = 3600;

            beforeEach(async function () {
                await vault.createBet(duration, depositPeriod);
                betId = 1;
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
                ).to.be.revertedWithCustomError(vault, "InvalidBetId");
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
                await vault.createBet(86400, 3600);
                betId = 1;
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
                await pythOracle.setPrice(BTC_FEED_ID, 899);

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
                await vault.createBet(86400, 3600);
                betId = 1;
            });

            it("Should end bet successfully after duration", async function () {
                await time.increase(86401);
                const closePrice = 1100;
                await pythOracle.setPrice(BTC_FEED_ID, closePrice);

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
                await vault.createBet(86400, 3600);
                betId = 1;

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
                await pythOracle.setPrice(BTC_FEED_ID, 1500);
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
                await pythOracle.setPrice(BTC_FEED_ID, 1500);

                const initialBalance = await mockToken.balanceOf(user2.address);
                await vault.connect(user2).claimRewards(betId);
                const finalBalance = await mockToken.balanceOf(user2.address);

                expect(finalBalance).to.equal(initialBalance);
            });

            it("Should revert when claiming from open bet", async function () {
                await vault.createBet(86400, 3600);
                await expect(
                    vault.connect(user1).claimRewards(2)
                ).to.be.revertedWithCustomError(vault, "BetNotOpen");
            });
        })
    })
})