import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const hundred = 100n * 10n ** 18n;
  const miniDEX = await ethers.deployContract("MiniDEX", [ethers.ZeroAddress, ethers.ZeroAddress]);
  await miniDEX.waitForDeployment();
  const miniDEX2 = await ethers.deployContract("MiniDEX", [await miniDEX.tokenA(), await miniDEX.tokenB()]);
  await miniDEX2.waitForDeployment();
  await (await miniDEX.mintForExchange(await miniDEX2.getAddress(), hundred, hundred * 2n)).wait();
  await (await miniDEX2.seedFixedPool(hundred, hundred * 2n)).wait();
  const arbitrage = await ethers.deployContract("Arbitrage");
  await arbitrage.waitForDeployment();

  console.log(`交易所 1 MiniDEX deployed to ${await miniDEX.getAddress()}`);
  console.log(`交易所 2 MiniDEX deployed to ${await miniDEX2.getAddress()}`);
  console.log(`Arbitrage deployed to ${await arbitrage.getAddress()}`);
  const pool1 = await miniDEX.pools(0);
  const pool2 = await miniDEX2.pools(0);
  console.log(`交易所 1 固定池（编号 0）：A ${ethers.formatUnits(pool1.reserveA, 18)}，B ${ethers.formatUnits(pool1.reserveB, 18)}`);
  console.log(`交易所 2 固定池（编号 0）：A ${ethers.formatUnits(pool2.reserveA, 18)}，B ${ethers.formatUnits(pool2.reserveB, 18)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
