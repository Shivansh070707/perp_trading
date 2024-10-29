const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Vault and VaultFactory Contracts", function () {
    let vaultFactory;
    let vault;
    let mockOracle;
    let mockToken;
    let owner;
    let user1;
    let user2;
    let user3;
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const PRECISION = ethers.parseEther("1");
    const MIN_COLLATERAL = ethers.parseUnits("1", 6); // 1e6

    beforeEach(async function () {
        [owner, user1, user2, user3] = await ethers.getSigners();

        // Deploy mock contracts
        const MockOracle = await ethers.getContractFactory("MockOracle");
        mockOracle = await MockOracle.deploy();

        const MockToken = await ethers.getContractFactory("MockToken");
        mockToken = await MockToken.deploy();

        // Deploy VaultFactory
        const VaultFactory = await ethers.getContractFactory("VaultFactory");
        vaultFactory = await VaultFactory.deploy();

        // Create new Vault instance
        const tx = await vaultFactory.createVault(
            mockOracle.target,
            mockToken.target
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(log => log.fragment.name === 'VaultCreated');
        const vaultAddress = event.args[0];

        // Get Vault instance
        const Vault = await ethers.getContractFactory("Vault");
        vault = Vault.attach(vaultAddress);

        // Set initial price in mock oracle
        await mockOracle.setPrice(ethers.parseEther("1000")); // Initial price $1000

        // Mint tokens to users
        const mintAmount = ethers.parseEther("10000");
        await mockToken.mint(user1.address, mintAmount);
        await mockToken.mint(user2.address, mintAmount);
        await mockToken.mint(user3.address, mintAmount);
    });

    describe("VaultFactory", function () {
        it("Should deploy factory with correct owner", async function () {
            expect(await vaultFactory.owner()).to.equal(owner.address);
        });

        it("Should revert when creating vault with zero oracle address", async function () {
            await expect(
                vaultFactory.createVault(ZERO_ADDRESS, await mockToken.getAddress())
            ).to.be.revertedWithCustomError(vaultFactory, "InvalidOracleAddress");
        });

        it("Should revert when creating vault with zero asset address", async function () {
            await expect(
                vaultFactory.createVault(await mockOracle.getAddress(), ZERO_ADDRESS)
            ).to.be.revertedWithCustomError(vaultFactory, "InvalidAssetAddress");
        });

        it("Should emit VaultCreated event", async function () {
            const tx = await vaultFactory.createVault(
                mockOracle.target,
                mockToken.target
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => log.fragment.name === 'VaultCreated');
            expect(event).to.not.be.undefined;
            expect(event.args[1]).to.equal(mockOracle.target);
            expect(event.args[2]).to.equal(mockToken.target);
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
                const duration = 86400; // 1 day
                const depositPeriod = 3600; // 1 hour

                await expect(vault.createBet(duration, depositPeriod))
                    .to.emit(vault, "BetCreated")
                    .withArgs(1, duration, ethers.parseEther("1000"));

                const bet = await vault._betDetails(1);
                expect(bet.assetPrice).to.equal(ethers.parseEther("1000"));
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
                await mockOracle.setPrice(0);
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
                const collateral = ethers.parseEther("100");
                const positionSize = ethers.parseEther("200");

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
                const collateral = ethers.parseEther("10");
                const positionSize = ethers.parseEther("20");

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
                    vault.connect(user1).placeBet(999, true, ethers.parseEther("10"), ethers.parseEther("20"))
                ).to.be.revertedWithCustomError(vault, "InvalidBetId");
            });

            it("Should revert with insufficient collateral", async function () {
                const lowCollateral = ethers.parseUnits("0.9", 6); // Less than MIN_COLLATERAL
                const positionSize = ethers.parseEther("20");

                await expect(
                    vault.connect(user1).placeBet(betId, true, lowCollateral, positionSize)
                ).to.be.revertedWithCustomError(vault, "CollateralTooLow");
            });

            it("Should revert when positionSize <= collateral", async function () {
                const collateral = ethers.parseEther("10");
                await expect(
                    vault.connect(user1).placeBet(betId, true, collateral, collateral)
                ).to.be.revertedWithCustomError(vault, "InvalidPositionSize");
            });

            it("Should revert after deposit period ends", async function () {
                await time.increase(depositPeriod + 1);
                await expect(
                    vault.connect(user1).placeBet(betId, true, ethers.parseEther("10"), ethers.parseEther("20"))
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
                const collateral = ethers.parseEther("100");
                const positionSize = ethers.parseEther("200");
                await vault.connect(user1).placeBet(
                    betId,
                    true,
                    collateral,
                    positionSize
                );
            });

            it("Should liquidate long position when price drops below liquidation price", async function () {
                const position = await vault.userPosition(user1.address, betId);
                const liquidationPrice = position.liquidationPrice;

                // Set price below liquidation price
                await mockOracle.setPrice(liquidationPrice - 1n);

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
                const closePrice = ethers.parseEther("1100");
                await mockOracle.setPrice(closePrice);

                await expect(vault.endBet(betId))
                    .to.emit(vault, "BetEnded")
                    .withArgs(betId, closePrice);

                const bet = await vault._betDetails(betId);
                expect(bet.isOpen).to.be.false;
                expect(bet.closePrice).to.equal(closePrice);
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
                    ethers.parseEther("10"),
                    ethers.parseEther("20")
                );
                await vault.connect(user2).placeBet(
                    betId,
                    false,
                    ethers.parseEther("10"),
                    ethers.parseEther("20")
                );

                // End bet
                await time.increase(86401);
                await vault.endBet(betId);
            });

            it("Should allow winner to claim rewards", async function () {
                // Set close price higher for long position win
                await mockOracle.setPrice(ethers.parseEther("1500"));

                const initialBalance = await mockToken.balanceOf(user1.address);
                await vault.connect(user1).claimRewards(betId);
                const finalBalance = await mockToken.balanceOf(user1.address);

                expect(finalBalance).to.be.gt(initialBalance);
            });

            it("Should not allow loser to claim rewards", async function () {
                // Set close price higher for long position win
                await mockOracle.setPrice(ethers.parseEther("1500"));

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