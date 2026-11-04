import hre from "hardhat";

// 模拟 20 个用户在两套交易所里随机兑换、添加和撤销流动性，并做一次跨交易所原子套利。
// 运行：npm run simulate   （使用 Hardhat 内置网络，不需要先启动节点）

const USERS = 20;
const ROUNDS = 80;
const SEED = 20261023;

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const { ethers } = await hre.network.create();
  const random = makeRandom(SEED);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const fmt = (value: bigint) => Number(ethers.formatUnits(value, 18)).toFixed(4);
  const parse = (value: number) => ethers.parseUnits(value.toFixed(4), 18);

  const signers = (await ethers.getSigners()).slice(0, USERS);
  if (signers.length < USERS) {
    throw new Error(`需要 ${USERS} 个账户，当前只有 ${signers.length} 个`);
  }
  const hundred = 100n * 10n ** 18n;
  const dex1 = await ethers.deployContract("MiniDEX", [ethers.ZeroAddress, ethers.ZeroAddress]);
  await dex1.waitForDeployment();
  const dex2 = await ethers.deployContract("MiniDEX", [await dex1.tokenA(), await dex1.tokenB()]);
  await dex2.waitForDeployment();
  await (await dex1.mintForExchange(await dex2.getAddress(), hundred, hundred * 2n)).wait();
  await (await dex2.seedFixedPool(hundred, hundred * 2n)).wait();
  const dexes = [dex1, dex2];
  const dexAddresses = [await dex1.getAddress(), await dex2.getAddress()];
  const tokenA = await ethers.getContractAt("MyERC20", await dex1.tokenA());
  const tokenB = await ethers.getContractAt("MyERC20", await dex1.tokenB());
  const addressA = await tokenA.getAddress();
  const addressB = await tokenB.getAddress();

  console.log(`交易所 1：${dexAddresses[0]}`);
  console.log(`交易所 2：${dexAddresses[1]}`);
  console.log(`模拟用户：${USERS} 个，随机操作：${ROUNDS} 次，随机种子：${SEED}\n`);

  // 1. 每个用户领取测试币。
  for (const user of signers) {
    await (await tokenA.connect(user).airdrop()).wait();
    await (await tokenB.connect(user).airdrop()).wait();
  }
  const initialEach = await tokenA.balanceOf(signers[0].address);
  console.log(`每个用户领取后：A ${fmt(initialEach)}，B ${fmt(await tokenB.balanceOf(signers[0].address))}`);

  // 2. 两套交易所各有一个固定池，使用同一对代币。交易所 1 是 100:100，交易所 2 是 100:200。
  async function price(dexIndex: number) {
    const pool = await dexes[dexIndex].pools(0);
    return Number(ethers.formatUnits(pool.reserveB, 18)) / Number(ethers.formatUnits(pool.reserveA, 18));
  }
  console.log("交易所 1 固定池（编号 0，A 100 : B 100），交易所 2 固定池（编号 0，A 100 : B 200）\n");

  // 用户自己的凭证。两套交易所的编号都会从 0 开始，所以要记下是哪一套。
  const owned: Map<number, { dexIndex: number; positionId: number }[]> = new Map();
  for (let i = 0; i < USERS; i++) owned.set(i, []);

  const stats = { swap: 0, add: 0, remove: 0, rejected: 0 };

  // 3. 随机操作。
  for (let round = 1; round <= ROUNDS; round++) {
    const userIndex = Math.floor(random() * USERS);
    const user = signers[userIndex];
    const dexIndex = Math.floor(random() * 2);
    const dex = dexes[dexIndex];
    const dexAddress = dexAddresses[dexIndex];
    const poolId = 0;
    const roll = random();
    const label = `#${String(round).padStart(2, "0")} 用户${userIndex} 交易所${dexIndex + 1}`;
    try {
      if (roll < 0.6) {
        // 兑换
        const sideA = random() < 0.5;
        const amount = parse(1 + random() * 19);
        const tokenIn = sideA ? tokenA : tokenB;
        const tokenOut = sideA ? tokenB : tokenA;
        const before = await tokenOut.balanceOf(user.address);
        await (await tokenIn.connect(user).approve(dexAddress, amount)).wait();
        await (await dex.connect(user).exchange(poolId, await tokenIn.getAddress(), amount)).wait();
        const got = (await tokenOut.balanceOf(user.address)) - before;
        stats.swap++;
        console.log(`${label} 兑换：${fmt(amount)} ${sideA ? "A" : "B"} -> ${fmt(got)} ${sideA ? "B" : "A"}，价格 B/A = ${(await price(dexIndex)).toFixed(4)}`);
      } else if (roll < 0.85) {
        // 添加流动性
        const sideA = random() < 0.5;
        const amount = parse(1 + random() * 14);
        const pool = await dex.pools(poolId);
        const needA = sideA ? amount : (amount * pool.reserveA) / pool.reserveB;
        const needB = sideA ? (amount * pool.reserveB) / pool.reserveA : amount;
        await (await tokenA.connect(user).approve(dexAddress, needA)).wait();
        await (await tokenB.connect(user).approve(dexAddress, needB)).wait();
        const positionId = Number(await dex.nextPositionId());
        await (await dex.connect(user).addLiquidity(poolId, amount, sideA ? addressA : addressB)).wait();
        owned.get(userIndex)!.push({ dexIndex, positionId });
        stats.add++;
        console.log(`${label} 添加流动性：A ${fmt(needA)} + B ${fmt(needB)}，得到 NFT ${positionId}`);
      } else {
        // 撤销流动性。固定池底仓不在 owned 里，用户撤光自己的份额后池子仍然有底仓。
        const mine = owned.get(userIndex)!.filter((item) => item.dexIndex === dexIndex);
        const pool = await dex.pools(poolId);
        const candidates = [];
        for (const item of mine) {
          const position = await dex.positions(item.positionId);
          if (position.share < pool.totalShare) candidates.push(item.positionId);
        }
        if (candidates.length === 0) {
          console.log(`${label} 没有可撤销的凭证，跳过`);
          continue;
        }
        const positionId = pick(candidates);
        const [feeA, feeB] = await dex.pendingFees(positionId);
        const beforeA = await tokenA.balanceOf(user.address);
        const beforeB = await tokenB.balanceOf(user.address);
        await (await dex.connect(user).removeLiquidity(positionId)).wait();
        owned.set(
          userIndex,
          owned.get(userIndex)!.filter((item) => !(item.dexIndex === dexIndex && item.positionId === positionId))
        );
        stats.remove++;
        console.log(
          `${label} 撤销 NFT ${positionId}：取回 A ${fmt((await tokenA.balanceOf(user.address)) - beforeA)}、B ${fmt((await tokenB.balanceOf(user.address)) - beforeB)}（其中手续费 A ${fmt(feeA)}、B ${fmt(feeB)}）`
        );
      }
    } catch (error) {
      stats.rejected++;
      const message = (error as Error).message.split("\n")[0];
      console.log(`${label} 被拒绝：${message}`);
    }
  }

  // 4. 汇总。
  console.log("\n===== 操作统计 =====");
  console.log(`兑换 ${stats.swap} 次，添加流动性 ${stats.add} 次，撤销流动性 ${stats.remove} 次，被拒绝 ${stats.rejected} 次`);

  console.log("\n===== 池子状态 =====");
  for (let dexIndex = 0; dexIndex < 2; dexIndex++) {
    const pool = await dexes[dexIndex].pools(0);
    console.log(
      `交易所 ${dexIndex + 1} 固定池：A ${fmt(pool.reserveA)}，B ${fmt(pool.reserveB)}，价格 B/A = ${(await price(dexIndex)).toFixed(4)}，总份额 ${fmt(pool.totalShare)}，累计手续费/份额 A ${ethers.formatUnits(pool.accFeeA, 18)} B ${ethers.formatUnits(pool.accFeeB, 18)}`
    );
  }
  const p0 = await price(0);
  const p1 = await price(1);
  console.log(`两个交易所的价差：${Math.abs(p0 - p1).toFixed(4)}（${p0.toFixed(4)} vs ${p1.toFixed(4)}）`);

  // 5. 原子套利：一笔交易里高价卖 A、低价买回 A。同一池子来回换会整笔回滚。
  console.log("\n===== 套利 =====");
  const arb = await ethers.deployContract("Arbitrage");
  await arb.waitForDeployment();
  const arbAddress = await arb.getAddress();
  const arbitrageur = signers[USERS - 1];
  const candidates = [1, 5, 10, 20, 50];
  let bestAmount = 0n;
  let bestQuote: Awaited<ReturnType<typeof arb.quote>> | undefined;
  for (const size of candidates) {
    const amount = parse(size);
    const quoted = await arb.quote(dexAddresses[0], 0, dexAddresses[1], 0, amount);
    if (!bestQuote || quoted.profitA > bestQuote.profitA) {
      bestAmount = amount;
      bestQuote = quoted;
    }
  }
  async function poolLine(dexIndex: number) {
    const pool = await dexes[dexIndex].pools(0);
    return `交易所 ${dexIndex + 1}：A ${fmt(pool.reserveA)}，B ${fmt(pool.reserveB)}，价格 B/A = ${(await price(dexIndex)).toFixed(4)}`;
  }
  const userABefore = await tokenA.balanceOf(arbitrageur.address);
  console.log(`套利前 ${await poolLine(0)}`);
  console.log(`套利前 ${await poolLine(1)}`);
  console.log(`套利账户 A ${fmt(userABefore)}`);
  if (!bestQuote || bestQuote.profitA === 0n) {
    console.log("当前价差盖不住两边手续费，没有可执行的套利");
  } else {
    console.log(
      `报价：在 ${bestQuote.dexSell} 的编号 ${bestQuote.poolSell} 卖出 ${fmt(bestAmount)} A，得到 ${fmt(bestQuote.amountBMid)} B，再在 ${bestQuote.dexBuy} 的编号 ${bestQuote.poolBuy} 买回 ${fmt(bestQuote.amountAOut)} A，利润 ${fmt(bestQuote.profitA)} A`
    );
    await (await tokenA.connect(arbitrageur).approve(arbAddress, bestAmount)).wait();
    await (await arb.connect(arbitrageur).execute(dexAddresses[0], 0, dexAddresses[1], 0, bestAmount)).wait();
    const userAAfter = await tokenA.balanceOf(arbitrageur.address);
    console.log(`套利后 ${await poolLine(0)}`);
    console.log(`套利后 ${await poolLine(1)}`);
    console.log(`套利账户 A ${fmt(userAAfter)}，实际利润 ${fmt(userAAfter - userABefore)} A`);
  }
  const unchanged = await tokenA.balanceOf(arbitrageur.address);
  let reverted = false;
  try {
    await arb.connect(arbitrageur).execute(dexAddresses[0], 0, dexAddresses[0], 0, parse(1));
  } catch (error) {
    reverted = true;
    console.log(`同一池子套利已回滚：${(error as Error).message.split("\n")[0]}`);
  }
  if (!reverted) {
    throw new Error("同一池子套利应该回滚");
  }
  const afterRevert = await tokenA.balanceOf(arbitrageur.address);
  console.log(`回滚后套利账户 A 仍为 ${fmt(afterRevert)}，变化 ${fmt(afterRevert - unchanged)} A`);
  if (afterRevert !== unchanged) {
    throw new Error("回滚后余额发生了变化");
  }

  // 6. 检查：合约持有的代币 = 池子储备 + 尚未领取的手续费（允许几 wei 的取整误差）。
  let reservesA = 0n;
  let reservesB = 0n;
  let feesA = 0n;
  let feesB = 0n;
  let heldA = 0n;
  let heldB = 0n;
  for (let dexIndex = 0; dexIndex < 2; dexIndex++) {
    const dex = dexes[dexIndex];
    const count = Number(await dex.poolCount());
    for (let poolId = 0; poolId < count; poolId++) {
      const pool = await dex.pools(poolId);
      reservesA += pool.reserveA;
      reservesB += pool.reserveB;
    }
    const livePositions = new Set<number>([0]);
    for (const list of owned.values()) {
      for (const item of list) if (item.dexIndex === dexIndex) livePositions.add(item.positionId);
    }
    for (const positionId of livePositions) {
      const [feeA, feeB] = await dex.pendingFees(positionId);
      feesA += feeA;
      feesB += feeB;
    }
    heldA += await tokenA.balanceOf(dexAddresses[dexIndex]);
    heldB += await tokenB.balanceOf(dexAddresses[dexIndex]);
  }
  console.log("\n===== 记账检查 =====");
  console.log(`两套交易所持有 A ${heldA}，储备 + 手续费 ${reservesA + feesA}，差 ${heldA - (reservesA + feesA)} wei`);
  console.log(`两套交易所持有 B ${heldB}，储备 + 手续费 ${reservesB + feesB}，差 ${heldB - (reservesB + feesB)} wei`);
  if (heldA < reservesA + feesA || heldB < reservesB + feesB) {
    throw new Error("记账检查失败：合约持有的代币少于应付的储备和手续费");
  }

  // 7. 所有人撤销全部流动性，检查总量守恒。
  console.log("\n===== 全部撤销后的用户收益 =====");
  for (let userIndex = 0; userIndex < USERS; userIndex++) {
    for (const item of [...owned.get(userIndex)!]) {
      await (await dexes[item.dexIndex].connect(signers[userIndex]).removeLiquidity(item.positionId)).wait();
    }
  }
  let totalA = 0n;
  let totalB = 0n;
  for (let userIndex = 0; userIndex < USERS; userIndex++) {
    const a = await tokenA.balanceOf(signers[userIndex].address);
    const b = await tokenB.balanceOf(signers[userIndex].address);
    totalA += a;
    totalB += b;
    console.log(`用户${userIndex}：A ${fmt(a)}（${fmt(a - initialEach)}），B ${fmt(b)}（${fmt(b - initialEach)}）`);
  }
  // 空投之外，两套交易所的固定池一共铸了 200 个 A 和 300 个 B。
  const expectedA = initialEach * BigInt(USERS) + 200n * 10n ** 18n;
  const expectedB = initialEach * BigInt(USERS) + 300n * 10n ** 18n;
  const leftA = (await tokenA.balanceOf(dexAddresses[0])) + (await tokenA.balanceOf(dexAddresses[1]));
  const leftB = (await tokenB.balanceOf(dexAddresses[0])) + (await tokenB.balanceOf(dexAddresses[1]));
  console.log(`\n所有用户 A 合计 ${fmt(totalA)}，B 合计 ${fmt(totalB)}`);
  console.log(`两套交易所中仍有 A ${fmt(leftA)}，B ${fmt(leftB)}（含固定池底仓）`);
  console.log(`A 发行量 ${fmt(expectedA)}，用户加合约 ${fmt(totalA + leftA)}`);
  console.log(`B 发行量 ${fmt(expectedB)}，用户加合约 ${fmt(totalB + leftB)}`);
  if (totalA + leftA !== expectedA || totalB + leftB !== expectedB) {
    throw new Error("总量检查失败：用户和合约持有的代币与发行量不一致");
  }
  console.log("\n模拟完成：记账检查和总量检查都通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
