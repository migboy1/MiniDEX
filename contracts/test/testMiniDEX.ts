import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

describe("MiniDEX", function () {
  async function deployFixture() {
    const [owner, otherAccount] = await ethers.getSigners();
    const miniDEX = await ethers.deployContract("MiniDEX", [ethers.ZeroAddress, ethers.ZeroAddress]);
    await miniDEX.waitForDeployment();

    return { miniDEX, owner, otherAccount };
  }

  describe("Deployment", function () {
    it("Should drop token A airdrop", async function () {
      const { miniDEX, owner } = await networkHelpers.loadFixture(deployFixture);
      const tokenA = await ethers.getContractAt("MyERC20", await miniDEX.tokenA());
      await tokenA.airdrop();
      expect(await tokenA.balanceOf(owner.address)).to.equal(500n * 10n ** 18n);
    });

    it("Should drop token B airdrop", async function () {
      const { miniDEX, owner } = await networkHelpers.loadFixture(deployFixture);
      const tokenB = await ethers.getContractAt("MyERC20", await miniDEX.tokenB());
      await tokenB.airdrop();
      expect(await tokenB.balanceOf(owner.address)).to.equal(500n * 10n ** 18n);
    });

    it("Should drop token B airdrop to another account", async function (){
      const { miniDEX, otherAccount } = await networkHelpers.loadFixture(deployFixture);
      const tokenB = await ethers.getContractAt("MyERC20", await miniDEX.tokenB());
      await tokenB.connect(otherAccount).airdrop();
      expect(await tokenB.balanceOf(otherAccount.address)).to.equal(500n * 10n ** 18n);
    });

    it("Should open one fixed pool", async function () {
      const { miniDEX } = await networkHelpers.loadFixture(deployFixture);
      const hundred = 100n * 10n ** 18n;
      expect(await miniDEX.poolCount()).to.equal(1);
      const pool0 = await miniDEX.pools(0);
      expect(pool0.reserveA).to.equal(hundred);
      expect(pool0.reserveB).to.equal(hundred);
      expect(await miniDEX.ownerOf(0n)).to.equal(await miniDEX.getAddress());
    });

    it("Should create pool", async function () {
      const { miniDEX, owner } = await networkHelpers.loadFixture(deployFixture);
      const tokenA = await ethers.getContractAt("MyERC20", await miniDEX.tokenA());
      const tokenB = await ethers.getContractAt("MyERC20", await miniDEX.tokenB());
      await tokenA.airdrop();
      await tokenB.airdrop();
      await tokenA.approve(await miniDEX.getAddress(), 10n ** 18n);
      await tokenB.approve(await miniDEX.getAddress(), 10n ** 18n);
      await miniDEX.createPool(await tokenA.getAddress(), await tokenB.getAddress(), 10n ** 18n, 10n ** 18n);
      // 编号 0 是固定池，用户新建的是编号 1，对应的凭证是 1。
      expect(await miniDEX.ownerOf(1n)).to.equal(owner.address);
      expect(await miniDEX.poolCount()).to.equal(2);
      const hundred = 100n * 10n ** 18n;
      expect(await tokenA.balanceOf(await miniDEX.getAddress())).to.equal(hundred + 10n ** 18n);
      expect(await tokenB.balanceOf(await miniDEX.getAddress())).to.equal(hundred + 10n ** 18n);
      const pool = await miniDEX.pools(1);
      expect(pool.tokenA).to.equal(await tokenA.getAddress());
      expect(pool.tokenB).to.equal(await tokenB.getAddress());
    });

    it("Should return the swap fee when liquidity is removed", async function () {
      const { miniDEX, owner, otherAccount } = await networkHelpers.loadFixture(deployFixture);
      const [, , trader] = await ethers.getSigners();
      const tokenA = await ethers.getContractAt("MyERC20", await miniDEX.tokenA());
      const tokenB = await ethers.getContractAt("MyERC20", await miniDEX.tokenB());
      const dex = await miniDEX.getAddress();
      const one = 10n ** 18n;

      await tokenA.airdrop();
      await tokenB.airdrop();
      await tokenA.approve(dex, one);
      await tokenB.approve(dex, one);
      await miniDEX.createPool(await tokenA.getAddress(), await tokenB.getAddress(), one, one);

      await tokenA.connect(otherAccount).airdrop();
      await tokenB.connect(otherAccount).airdrop();
      await tokenA.connect(otherAccount).approve(dex, one);
      await tokenB.connect(otherAccount).approve(dex, one);
      await miniDEX.connect(otherAccount).addLiquidity(1n, one, await tokenA.getAddress());

      await tokenA.connect(trader).airdrop();
      await tokenA.connect(trader).approve(dex, one);
      await miniDEX.connect(trader).exchange(1n, await tokenA.getAddress(), one);

      const reserve = 2n * one;
      const fee = one * 3n / 1000n;
      const amountOut = reserve * (one - fee) / (reserve + one - fee);
      const noFeeOut = reserve * one / (reserve + one);
      const receivedB = (reserve - amountOut) / 2n;
      const receivedBWithoutFee = (reserve - noFeeOut) / 2n;

      // 手续费单独记账：池子里有两个等额的流动性提供者，各分一半。
      const [pendingA, pendingB] = await miniDEX.pendingFees(1n);
      expect(pendingA).to.equal(fee / 2n);
      expect(pendingB).to.equal(0n);
      const [otherPendingA] = await miniDEX.pendingFees(2n);
      expect(otherPendingA).to.equal(fee / 2n);

      await miniDEX.removeLiquidity(1n);

      expect(await tokenA.balanceOf(owner.address)).to.equal(499n * one + (reserve + one) / 2n);
      expect(await tokenB.balanceOf(owner.address)).to.equal(499n * one + receivedB);
      expect(receivedB > receivedBWithoutFee).to.equal(true);
      await expect(miniDEX.ownerOf(1n)).to.revert(ethers);
    });
  });
});
