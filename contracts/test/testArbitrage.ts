import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

async function deployExchanges() {
  const [owner] = await ethers.getSigners();
  const miniDEX = await ethers.deployContract("MiniDEX", [ethers.ZeroAddress, ethers.ZeroAddress]);
  await miniDEX.waitForDeployment();
  const miniDEX2 = await ethers.deployContract("MiniDEX", [await miniDEX.tokenA(), await miniDEX.tokenB()]);
  await miniDEX2.waitForDeployment();
  const hundred = 100n * 10n ** 18n;
  await miniDEX.mintForExchange(await miniDEX2.getAddress(), hundred, hundred * 2n);
  await miniDEX2.seedFixedPool(hundred, hundred * 2n);
  const arbitrage = await ethers.deployContract("Arbitrage");
  await arbitrage.waitForDeployment();
  const tokenA = await ethers.getContractAt("MyERC20", await miniDEX.tokenA());
  const tokenB = await ethers.getContractAt("MyERC20", await miniDEX.tokenB());
  return { miniDEX, miniDEX2, arbitrage, tokenA, tokenB, owner };
}

describe("Arbitrage", function () {
  async function deployFixture() {
    return deployExchanges();
  }

  it("buys on the cheaper exchange and sells on the dearer one", async function () {
    const { miniDEX, miniDEX2, arbitrage, tokenA, owner } = await networkHelpers.loadFixture(deployFixture);
    const dex1 = await miniDEX.getAddress();
    const dex2 = await miniDEX2.getAddress();
    const amount = 10n * 10n ** 18n;
    await tokenA.airdrop();
    await tokenA.approve(await arbitrage.getAddress(), amount);

    const beforeA = await tokenA.balanceOf(owner.address);
    const sellBefore = await miniDEX2.pools(0);
    const buyBefore = await miniDEX.pools(0);
    const quoted = await arbitrage.quote(dex1, 0, dex2, 0, amount);
    expect(quoted.dexSell).to.equal(dex2);
    expect(quoted.dexBuy).to.equal(dex1);
    expect(quoted.profitA).to.be.gt(0n);

    await expect(arbitrage.execute(dex1, 0, dex2, 0, amount)).to.emit(arbitrage, "ArbitrageExecuted");

    const afterA = await tokenA.balanceOf(owner.address);
    expect(afterA - beforeA).to.equal(quoted.profitA);
    const sellAfter = await miniDEX2.pools(0);
    const buyAfter = await miniDEX.pools(0);
    const price = (reserveA: bigint, reserveB: bigint) => (reserveB * 10n ** 18n) / reserveA;
    expect(price(sellAfter.reserveA, sellAfter.reserveB)).to.be.lt(price(sellBefore.reserveA, sellBefore.reserveB));
    expect(price(buyAfter.reserveA, buyAfter.reserveB)).to.be.gt(price(buyBefore.reserveA, buyBefore.reserveB));
  });

  it("reverts the whole transaction when the round trip loses money", async function () {
    const { miniDEX, arbitrage, tokenA, tokenB, owner } = await networkHelpers.loadFixture(deployFixture);
    const dex = await miniDEX.getAddress();
    const one = 10n ** 18n;
    const hundred = 100n * one;
    const tilted = hundred + hundred / 1000n;
    await tokenA.airdrop();
    await tokenB.airdrop();
    await tokenA.approve(dex, hundred);
    await tokenB.approve(dex, tilted);
    await miniDEX.createPool(await tokenA.getAddress(), await tokenB.getAddress(), hundred, tilted);

    const amount = one;
    await tokenA.approve(await arbitrage.getAddress(), amount);
    const beforeA = await tokenA.balanceOf(owner.address);
    const before0 = await miniDEX.pools(0);
    await expect(arbitrage.execute(dex, 0, dex, 1, amount)).to.be.revertedWith("no profit");
    expect(await tokenA.balanceOf(owner.address)).to.equal(beforeA);
    const after0 = await miniDEX.pools(0);
    expect(after0.reserveA).to.equal(before0.reserveA);
    expect(after0.reserveB).to.equal(before0.reserveB);
  });

  it("reverts when both legs use the same pool", async function () {
    const { miniDEX, arbitrage, tokenA, owner } = await networkHelpers.loadFixture(deployFixture);
    const beforeA = await tokenA.balanceOf(owner.address);
    const dex = await miniDEX.getAddress();
    await expect(arbitrage.execute(dex, 0, dex, 0, 10n ** 18n)).to.be.revertedWith("same pool");
    expect(await tokenA.balanceOf(owner.address)).to.equal(beforeA);
  });
});
