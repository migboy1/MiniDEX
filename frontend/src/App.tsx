import { useEffect, useState } from "react";
import { ethers } from "ethers";

const DEX_ABI = [
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function poolCount() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function pools(uint256) view returns (address tokenA, address tokenB, uint256 reserveA, uint256 reserveB, uint256 createdTimestamp, uint256 totalShare, uint256 accFeeA, uint256 accFeeB)",
  "function pendingFees(uint256 positionId) view returns (uint256 feeA, uint256 feeB)",
  "function positions(uint256) view returns (uint256 poolId, uint256 share, uint256 amountA, uint256 amountB, uint256 createdTimestamp, uint256 feeDebtA, uint256 feeDebtB)",
  "function ownerOf(uint256) view returns (address)",
  "function createPool(address token_A, address token_B, uint256 initialAmountA, uint256 initialAmountB)",
  "function addLiquidity(uint256 poolId, uint256 amountToken, address token)",
  "function exchange(uint256 poolId, address tokenIn, uint256 amountIn)",
  "function removeLiquidity(uint256 positionId)",
];

const ERC20_ABI = [
  "function airdrop()",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const DEX1_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEX2_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const ARB_ADDRESS = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const ARB_ABI = [
  "function quote(address dex0, uint256 pool0, address dex1, uint256 pool1, uint256 amountAIn) view returns (address dexSell, address dexBuy, uint256 poolSell, uint256 poolBuy, uint256 priceSell, uint256 priceBuy, uint256 amountBMid, uint256 amountAOut, uint256 profitA)",
  "function execute(address dex0, uint256 pool0, address dex1, uint256 pool1, uint256 amountAIn) returns (uint256 profitA)",
  "event ArbitrageExecuted(address indexed trader, address dexSell, address dexBuy, uint256 poolSell, uint256 poolBuy, uint256 amountAIn, uint256 amountBMid, uint256 amountAOut, uint256 profitA)",
];
const LOCAL_RPC = "http://127.0.0.1:8545";
const LOCAL_CHAIN_ID = "0x539";
const CLAIM_ETH = "0x56BC75E2D63100000";

type PoolView = {
  exchange: number;
  id: number;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  reserveARaw: string;
  reserveBRaw: string;
  price: string;
  totalShare: string;
  createdAt: string;
};

type PositionView = {
  exchange: number;
  id: number;
  poolId: string;
  share: string;
  amountA: string;
  amountB: string;
  createdAt: string;
  poolPercent: string;
  nowA: string;
  nowB: string;
  diffA: string;
  diffB: string;
  feeA: string;
  feeB: string;
};

function formatToken(value: bigint, digits = 4) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(digits);
  const base = 10n ** 18n;
  const rounded = (abs * scale + base / 2n) / base;
  const whole = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(digits, "0").replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}

function signed(value: bigint) {
  const text = formatToken(value);
  return value > 0n ? `+${text}` : text;
}

function formatTime(timestamp: bigint) {
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

function formatPrice(reserveA: bigint, reserveB: bigint) {
  if (reserveA === 0n) {
    return "0";
  }
  const scaled = (reserveB * 10000n) / reserveA;
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, "0")}`;
}

function poolTitle(exchange: number, id: number) {
  if (id === 0) {
    return `交易所 ${exchange} 固定池（编号 0）`;
  }
  return `交易所 ${exchange} 池子 ${id}`;
}

function dexAddressOf(exchange: string) {
  return exchange === "2" ? DEX2_ADDRESS : DEX1_ADDRESS;
}

function explain(error: unknown) {
  const value = error as { code?: number; message?: string; info?: { error?: { message?: string } } };
  const code = value?.code;
  if (code === 4001) {
    return "你在 MetaMask 里取消了请求";
  }
  if (code === -32002) {
    return "MetaMask 还有一个未处理的弹窗，先把它确认或关掉";
  }
  const message = value?.info?.error?.message || value?.message;
  if (message) {
    return message;
  }
  return error instanceof Error ? error.message : "交易失败";
}

async function readHardhatEth(address: string) {
  const response = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message ?? "读取以太币余额失败");
  }
  return formatToken(BigInt(data.result));
}

async function ensureLocalChain() {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    throw new Error("没有检测到 MetaMask");
  }
  const onLocalChain = async () => {
    const chainId = await ethereum.request({ method: "eth_chainId" });
    return String(chainId).toLowerCase() === LOCAL_CHAIN_ID;
  };
  try {
    if (!(await onLocalChain())) {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: LOCAL_CHAIN_ID }],
      });
    }
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) {
      throw new Error(explain(error));
    }
    try {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: LOCAL_CHAIN_ID,
            chainName: "Hardhat Local",
            rpcUrls: [LOCAL_RPC],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          },
        ],
      });
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: LOCAL_CHAIN_ID }],
      });
    } catch (addError) {
      throw new Error(explain(addError));
    }
  }
  if (!(await onLocalChain())) {
    throw new Error("请在 MetaMask 顶部点网络名称，选择 Ganache Test Chain");
  }
  return ethereum;
}

async function getContracts() {
  const ethereum = await ensureLocalChain();
  if (!ethers.isAddress(DEX1_ADDRESS) || !ethers.isAddress(DEX2_ADDRESS)) {
    throw new Error("请先把交易所地址换成部署后的合约地址");
  }
  const provider = new ethers.BrowserProvider(ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const dex1 = new ethers.Contract(DEX1_ADDRESS, DEX_ABI, signer);
  const dex2 = new ethers.Contract(DEX2_ADDRESS, DEX_ABI, signer);
  const tokenA = new ethers.Contract(await dex1.tokenA(), ERC20_ABI, signer);
  const tokenB = new ethers.Contract(await dex1.tokenB(), ERC20_ABI, signer);
  return { signer, dex1, dex2, tokenA, tokenB };
}

function App() {
  const [account, setAccount] = useState("");
  const [ethBalance, setEthBalance] = useState("0");
  const [balanceA, setBalanceA] = useState("0");
  const [balanceB, setBalanceB] = useState("0");
  const [pools, setPools] = useState<PoolView[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [amount, setAmount] = useState("0");
  const [opAmount, setOpAmount] = useState("0");
  const [venue, setVenue] = useState("1");
  const [poolIdText, setPoolIdText] = useState("0");
  const [side, setSide] = useState<"A" | "B">("A");
  const [arbEx0, setArbEx0] = useState("1");
  const [arbPool0, setArbPool0] = useState("0");
  const [arbEx1, setArbEx1] = useState("2");
  const [arbPool1, setArbPool1] = useState("0");
  const [arbAmount, setArbAmount] = useState("10");
  const [arbResult, setArbResult] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const list = pools.filter((pool) => pool.exchange === Number(venue));
    if (list.length > 0 && !list.some((pool) => String(pool.id) === poolIdText)) {
      setPoolIdText(String(list[0].id));
    }
  }, [pools, venue, poolIdText]);

  useEffect(() => {
    const list = pools.filter((pool) => pool.exchange === Number(arbEx0));
    if (list.length > 0 && !list.some((pool) => String(pool.id) === arbPool0)) {
      setArbPool0(String(list[0].id));
    }
  }, [pools, arbEx0, arbPool0]);

  useEffect(() => {
    const list = pools.filter((pool) => pool.exchange === Number(arbEx1));
    if (list.length > 0 && !list.some((pool) => String(pool.id) === arbPool1)) {
      setArbPool1(String(list[0].id));
    }
  }, [pools, arbEx1, arbPool1]);

  async function refresh() {
    const { signer, dex1, dex2, tokenA, tokenB } = await getContracts();
    const address = await signer.getAddress();
    setAccount(address);
    setEthBalance(await readHardhatEth(address));
    setBalanceA(formatToken(await tokenA.balanceOf(address)));
    setBalanceB(formatToken(await tokenB.balanceOf(address)));

    const nextPools: PoolView[] = [];
    const owned: PositionView[] = [];
    for (const [exchange, dex] of [[1, dex1], [2, dex2]] as const) {
      const count = Number(await dex.poolCount());
      for (let i = 0; i < count; i++) {
        const pool = await dex.pools(i);
        const reserveA = pool.reserveA as bigint;
        const reserveB = pool.reserveB as bigint;
        nextPools.push({
          exchange,
          id: i,
          tokenA: pool.tokenA,
          tokenB: pool.tokenB,
          reserveA: formatToken(reserveA),
          reserveB: formatToken(reserveB),
          reserveARaw: reserveA.toString(),
          reserveBRaw: reserveB.toString(),
          price: formatPrice(reserveA, reserveB),
          totalShare: formatToken(pool.totalShare),
          createdAt: formatTime(pool.createdTimestamp),
        });
      }

      const nextId = Number(await dex.nextPositionId());
      for (let i = 0; i < nextId; i++) {
        try {
          const owner = await dex.ownerOf(i);
          if (owner.toLowerCase() !== address.toLowerCase()) {
            continue;
          }
          const position = await dex.positions(i);
          const pool = await dex.pools(position.poolId);
          // 当前取回的数量 = 池子储备 × 份额 ÷ 总份额，和合约 removeLiquidity 一致。
          const share = position.share as bigint;
          const totalShare = pool.totalShare as bigint;
          const nowA = ((pool.reserveA as bigint) * share) / totalShare;
          const nowB = ((pool.reserveB as bigint) * share) / totalShare;
          const percent = Number((share * 10000n) / totalShare) / 100;
          const fees = await dex.pendingFees(i);
          owned.push({
            exchange,
            feeA: formatToken(fees.feeA as bigint),
            feeB: formatToken(fees.feeB as bigint),
            poolPercent: percent.toFixed(2),
            nowA: formatToken(nowA),
            nowB: formatToken(nowB),
            diffA: signed(nowA - (position.amountA as bigint)),
            diffB: signed(nowB - (position.amountB as bigint)),
            id: i,
            poolId: position.poolId.toString(),
            share: formatToken(position.share),
            amountA: formatToken(position.amountA),
            amountB: formatToken(position.amountB),
            createdAt: formatTime(position.createdTimestamp),
          });
        } catch {
          // 已销毁的凭证没有持有人。
        }
      }
    }
    setPools(nextPools);
    setPositions(owned);
  }

  // 打开页面时，如果钱包已授权且在本地链上，自动读取余额和池子，不弹出 MetaMask。
  async function loadSilently() {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      return;
    }
    try {
      const accounts: string[] = await ethereum.request({ method: "eth_accounts" });
      const chainId = await ethereum.request({ method: "eth_chainId" });
      if (accounts.length === 0 || String(chainId).toLowerCase() !== LOCAL_CHAIN_ID) {
        return;
      }
      await refresh();
    } catch {
      // 静默加载失败时保持初始状态，用户可以手动点按钮。
    }
  }

  useEffect(() => {
    loadSilently();
    const ethereum = (window as any).ethereum;
    ethereum?.on?.("accountsChanged", loadSilently);
    ethereum?.on?.("chainChanged", loadSilently);
    return () => {
      ethereum?.removeListener?.("accountsChanged", loadSilently);
      ethereum?.removeListener?.("chainChanged", loadSilently);
    };
  }, []);

  async function run(action: () => Promise<void>) {
    try {
      setStatus("请在钱包中确认");
      await action();
      await refresh();
      setStatus("完成");
    } catch (error) {
      setStatus(explain(error));
    }
  }

  async function connect() {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error("没有检测到 MetaMask");
    }
    const provider = new ethers.BrowserProvider(ethereum);
    await provider.send("eth_requestAccounts", []);
    const address = await (await provider.getSigner()).getAddress();
    setAccount(address);
    setEthBalance(await readHardhatEth(address));
  }

  async function claimEth() {
    const ethereum = await ensureLocalChain();
    const provider = new ethers.BrowserProvider(ethereum);
    const address = await (await provider.getSigner()).getAddress();
    const balanceResponse = await fetch(LOCAL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    const balanceData = await balanceResponse.json();
    if (balanceData.error) {
      throw new Error(balanceData.error.message ?? "读取以太币余额失败");
    }
    const nextBalance = BigInt(balanceData.result) + BigInt(CLAIM_ETH);
    const response = await fetch(LOCAL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "hardhat_setBalance",
        params: [address, ethers.toQuantity(nextBalance)],
      }),
    });
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message ?? "领取以太币失败");
    }
    setAccount(address);
    setEthBalance(ethers.formatEther(nextBalance));
    await fetch(LOCAL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "hardhat_mine", params: [] }),
    });
  }

  async function claim() {
    const { tokenA, tokenB } = await getContracts();
    await (await tokenA.airdrop()).wait();
    await (await tokenB.airdrop()).wait();
  }

  function readAmount(text: string) {
    let value: bigint;
    try {
      value = ethers.parseUnits(text.trim(), 18);
    } catch {
      throw new Error("数量格式不正确，请输入数字");
    }
    if (value <= 0n) {
      throw new Error("数量必须大于 0");
    }
    return value;
  }

  async function requireBalance(token: ethers.Contract, owner: string, needed: bigint, name: string) {
    const balance: bigint = await token.balanceOf(owner);
    if (needed > balance) {
      throw new Error(`${name} 余额不足：需要 ${formatToken(needed)}，当前只有 ${formatToken(balance)}`);
    }
  }

  async function createPool() {
    const value = readAmount(amount);
    const contracts = await getContracts();
    const dex = venue === "2" ? contracts.dex2 : contracts.dex1;
    const me = await contracts.signer.getAddress();
    await requireBalance(contracts.tokenA, me, value, "Token A");
    await requireBalance(contracts.tokenB, me, value, "Token B");
    const dexAddress = dexAddressOf(venue);
    await (await contracts.tokenA.approve(dexAddress, value)).wait();
    await (await contracts.tokenB.approve(dexAddress, value)).wait();
    await (await dex.createPool(await contracts.tokenA.getAddress(), await contracts.tokenB.getAddress(), value, value)).wait();
  }

  async function readPool(dex: ethers.Contract) {
    const id = Number(poolIdText);
    if (!Number.isInteger(id) || id < 0 || id >= Number(await dex.poolCount())) {
      throw new Error("池子编号不存在");
    }
    return { id, pool: await dex.pools(id) };
  }

  async function addLiquidity() {
    const value = readAmount(opAmount);
    const contracts = await getContracts();
    const dex = venue === "2" ? contracts.dex2 : contracts.dex1;
    const signer = contracts.signer;
    const { id, pool } = await readPool(dex);
    const inputToken = side === "A" ? pool.tokenA : pool.tokenB;
    const contractA = new ethers.Contract(pool.tokenA, ERC20_ABI, signer);
    const contractB = new ethers.Contract(pool.tokenB, ERC20_ABI, signer);
    const me = await signer.getAddress();
    // 另一种代币的需要量按池子比例计算，和合约里的算法一致。
    const needA: bigint = side === "A" ? value : (value * pool.reserveA) / pool.reserveB;
    const needB: bigint = side === "B" ? value : (value * pool.reserveB) / pool.reserveA;
    await requireBalance(contractA, me, needA, "Token A");
    await requireBalance(contractB, me, needB, "Token B");
    const dexAddress = dexAddressOf(venue);
    await (await contractA.approve(dexAddress, needA)).wait();
    await (await contractB.approve(dexAddress, needB)).wait();
    await (await dex.addLiquidity(id, value, inputToken)).wait();
  }

  async function exchange() {
    const value = readAmount(opAmount);
    const contracts = await getContracts();
    const dex = venue === "2" ? contracts.dex2 : contracts.dex1;
    const signer = contracts.signer;
    const { id, pool } = await readPool(dex);
    const tokenIn = side === "A" ? pool.tokenA : pool.tokenB;
    const reserveIn: bigint = side === "A" ? pool.reserveA : pool.reserveB;
    const reserveOut: bigint = side === "A" ? pool.reserveB : pool.reserveA;
    const outName = side === "A" ? "Token B" : "Token A";
    if (reserveIn === 0n || reserveOut === 0n) {
      throw new Error(`池子 ${id} 里没有流动性，无法兑换`);
    }
    // 和合约里的公式一致：先扣 0.3% 手续费，再按恒定乘积计算。
    const fee = (value * 3n) / 1000n;
    const amountOut = (reserveOut * (value - fee)) / (reserveIn + value - fee);
    if (amountOut === 0n) {
      throw new Error("兑换数量太小，换不到任何代币");
    }
    if (amountOut > reserveOut) {
      throw new Error(`池子里的 ${outName} 不足：需要 ${formatToken(amountOut)}，池子只有 ${formatToken(reserveOut)}`);
    }
    const contractIn = new ethers.Contract(tokenIn, ERC20_ABI, signer);
    await requireBalance(contractIn, await signer.getAddress(), value, side === "A" ? "Token A" : "Token B");
    await (await contractIn.approve(dexAddressOf(venue), value)).wait();
    await (await dex.exchange(id, tokenIn, value)).wait();
  }

  async function removeLiquidity(exchange: number, positionId: number) {
    const contracts = await getContracts();
    const dex = exchange === 2 ? contracts.dex2 : contracts.dex1;
    await (await dex.removeLiquidity(positionId)).wait();
  }

  // 实时预估：只用页面上已读到的池子储备计算，不请求钱包。
  function quoteText() {
    const pool = pools.find((item) => item.exchange === Number(venue) && String(item.id) === poolIdText.trim());
    if (!pool || opAmount.trim() === "") {
      return "";
    }
    let value: bigint;
    try {
      value = ethers.parseUnits(opAmount.trim(), 18);
    } catch {
      return "";
    }
    if (value <= 0n) {
      return "";
    }
    const reserveA = BigInt(pool.reserveARaw);
    const reserveB = BigInt(pool.reserveBRaw);
    if (reserveA === 0n || reserveB === 0n) {
      return "";
    }
    const reserveIn = side === "A" ? reserveA : reserveB;
    const reserveOut = side === "A" ? reserveB : reserveA;
    const inName = side === "A" ? "A" : "B";
    const outName = side === "A" ? "B" : "A";
    const fee = (value * 3n) / 1000n;
    const out = (reserveOut * (value - fee)) / (reserveIn + value - fee);
    const needOther = (value * reserveOut) / reserveIn;
    return `预估：兑换 ${opAmount} 个 ${inName}，约可得 ${formatToken(out)} 个 ${outName}（含 0.3% 手续费）；添加流动性需要同时投入约 ${formatToken(needOther)} 个 ${outName}`;
  }

  function swapOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint) {
    if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) {
      return 0n;
    }
    const fee = (amountIn * 3n) / 1000n;
    if (fee >= amountIn) {
      return 0n;
    }
    const net = amountIn - fee;
    return (reserveOut * net) / (reserveIn + net);
  }

  function findPool(exchange: string, poolId: string) {
    return pools.find((item) => item.exchange === Number(exchange) && String(item.id) === poolId.trim());
  }

  function arbQuoteText() {
    const left = findPool(arbEx0, arbPool0);
    const right = findPool(arbEx1, arbPool1);
    if (!left || !right || (left.exchange === right.exchange && left.id === right.id) || arbAmount.trim() === "") {
      return "";
    }
    let value: bigint;
    try {
      value = ethers.parseUnits(arbAmount.trim(), 18);
    } catch {
      return "";
    }
    if (value <= 0n) {
      return "";
    }
    const leftA = BigInt(left.reserveARaw);
    const leftB = BigInt(left.reserveBRaw);
    const rightA = BigInt(right.reserveARaw);
    const rightB = BigInt(right.reserveBRaw);
    if (leftA === 0n || leftB === 0n || rightA === 0n || rightB === 0n) {
      return "选中的池子已经没有储备，不能套利";
    }
    const leftPrice = (leftB * 10n ** 18n) / leftA;
    const rightPrice = (rightB * 10n ** 18n) / rightA;
    if (leftPrice === rightPrice) {
      return "两个池子价格相同，没有套利空间";
    }
    const sell = leftPrice > rightPrice ? left : right;
    const buy = leftPrice > rightPrice ? right : left;
    const sellA = BigInt(sell.reserveARaw);
    const sellB = BigInt(sell.reserveBRaw);
    const buyA = BigInt(buy.reserveARaw);
    const buyB = BigInt(buy.reserveBRaw);
    const mid = swapOut(sellA, sellB, value);
    const back = swapOut(buyB, buyA, mid);
    const profit = back > value ? back - value : 0n;
    return `预估：在交易所 ${sell.exchange} 编号 ${sell.id} 卖出 ${arbAmount} 个 A，得到 ${formatToken(mid)} 个 B，再在交易所 ${buy.exchange} 编号 ${buy.id} 买回 ${formatToken(back)} 个 A，利润 ${formatToken(profit)} 个 A`;
  }

  async function executeArbitrage() {
    const value = readAmount(arbAmount);
    const left = Number(arbPool0);
    const right = Number(arbPool1);
    if (!Number.isInteger(left) || !Number.isInteger(right)) {
      throw new Error("池子编号不正确");
    }
    const { signer, tokenA } = await getContracts();
    const me = await signer.getAddress();
    await requireBalance(tokenA, me, value, "Token A");
    const arb = new ethers.Contract(ARB_ADDRESS, ARB_ABI, signer);
    const dex0 = dexAddressOf(arbEx0);
    const dex1 = dexAddressOf(arbEx1);
    const quoted = await arb.quote(dex0, left, dex1, right, value);
    if (quoted.profitA === 0n) {
      throw new Error("这笔数量不能盈利，交易会回滚，没有发送");
    }
    await (await tokenA.approve(ARB_ADDRESS, value)).wait();
    const tx = await arb.execute(dex0, left, dex1, right, value);
    const receipt = await tx.wait();
    const exchangeNo = (address: string) => (address.toLowerCase() === DEX2_ADDRESS.toLowerCase() ? "2" : "1");
    let result = `卖出交易所 ${exchangeNo(quoted.dexSell)} 编号 ${quoted.poolSell}，买入交易所 ${exchangeNo(quoted.dexBuy)} 编号 ${quoted.poolBuy}，投入 ${formatToken(value)} A，中间得到 ${formatToken(quoted.amountBMid)} B，换回 ${formatToken(quoted.amountAOut)} A，利润 ${formatToken(quoted.profitA)} A`;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = arb.interface.parseLog(log);
        if (parsed?.name === "ArbitrageExecuted") {
          result = `卖出交易所 ${exchangeNo(parsed.args.dexSell)} 编号 ${parsed.args.poolSell}，价格 ${formatToken(quoted.priceSell)} 起；买入交易所 ${exchangeNo(parsed.args.dexBuy)} 编号 ${parsed.args.poolBuy}，价格 ${formatToken(quoted.priceBuy)} 起。\n投入 ${formatToken(parsed.args.amountAIn)} A，得到 ${formatToken(parsed.args.amountBMid)} B，买回 ${formatToken(parsed.args.amountAOut)} A，利润 ${formatToken(parsed.args.profitA)} A。完成后的价格见上方池子列表。`;
        }
      } catch {
        // 其他合约的日志跳过。
      }
    }
    setArbResult(result);
  }

  function PoolSelect({
    exchange,
    value,
    onChange,
  }: {
    exchange: string;
    value: string;
    onChange: (next: string) => void;
  }) {
    const list = pools.filter((pool) => pool.exchange === Number(exchange));
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {list.length === 0 ? <option value={value || "0"}>固定池（编号 0）</option> : null}
        {list.map((pool) => (
          <option key={pool.id} value={String(pool.id)}>
            {pool.id === 0 ? `固定池 0（价格 ${pool.price}）` : `池子 ${pool.id}（价格 ${pool.price}）`}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div style={{ color: "#111", background: "#fff", minHeight: "100vh", padding: 16 }}>
      <button
        onClick={async () => {
          try {
            setStatus("请在钱包中确认");
            await connect();
            setStatus("完成");
          } catch (error) {
            setStatus(explain(error));
          }
        }}
      >
        连接钱包
      </button>
      <p>当前账户：{account}</p>
      <p>ETH：{ethBalance}</p>
      <p>Token A：{balanceA}</p>
      <p>Token B：{balanceB}</p>
      <button onClick={() => run(claimEth)}>领取测试以太币</button>
      <button onClick={() => run(claim)}>领取测试币</button>

      <h3>创建池子</h3>
      <p>
        交易所{" "}
        <select value={venue} onChange={(event) => setVenue(event.target.value)}>
          <option value="1">交易所 1</option>
          <option value="2">交易所 2</option>
        </select>{" "}
        A、B 各存入{" "}
        <input value={amount} onChange={(event) => setAmount(event.target.value)} />
      </p>
      <button onClick={() => run(createPool)}>创建池子</button>

      <h3>操作已有池子</h3>
      <p>
        交易所{" "}
        <select value={venue} onChange={(event) => setVenue(event.target.value)}>
          <option value="1">交易所 1</option>
          <option value="2">交易所 2</option>
        </select>{" "}
        池子{" "}
        <PoolSelect exchange={venue} value={poolIdText} onChange={setPoolIdText} />{" "}
        投入的代币{" "}
        <select value={side} onChange={(event) => setSide(event.target.value as "A" | "B")}>
          <option value="A">Token A</option>
          <option value="B">Token B</option>
        </select>{" "}
        投入数量{" "}
        <input value={opAmount} onChange={(event) => setOpAmount(event.target.value)} />
      </p>
      <button onClick={() => run(addLiquidity)}>添加流动性</button>
      <button onClick={() => run(exchange)}>
        {side === "A" ? "用 A 兑换 B" : "用 B 兑换 A"}
      </button>
      {quoteText() ? <p style={{ color: "#555" }}>{quoteText()}</p> : null}

      <h3>交易池</h3>
      <p>两套交易所使用同一对代币。交易所 1 的固定池初始为 100 A : 100 B，交易所 2 的固定池初始为 100 A : 200 B。两边的固定池编号都是 0。</p>
      {pools.length === 0 ? <p>还没有池子</p> : null}
      {pools.map((pool) => (
        <p key={`${pool.exchange}-${pool.id}`}>
          {poolTitle(pool.exchange, pool.id)}：A {pool.reserveA}，B {pool.reserveB}，价格 B/A = {pool.price}，总份额 {pool.totalShare}，创建时间 {pool.createdAt}
        </p>
      ))}

      <h3>套利</h3>
      <p>
        交易所{" "}
        <select value={arbEx0} onChange={(event) => setArbEx0(event.target.value)}>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>{" "}
        池子{" "}
        <PoolSelect exchange={arbEx0} value={arbPool0} onChange={setArbPool0} />{" "}
        和交易所{" "}
        <select value={arbEx1} onChange={(event) => setArbEx1(event.target.value)}>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>{" "}
        池子{" "}
        <PoolSelect exchange={arbEx1} value={arbPool1} onChange={setArbPool1} />{" "}
        投入 A{" "}
        <input value={arbAmount} onChange={(event) => setArbAmount(event.target.value)} />
      </p>
      <button onClick={() => run(executeArbitrage)}>执行套利</button>
      {arbQuoteText() ? <p style={{ color: "#555" }}>{arbQuoteText()}</p> : null}
      {arbResult ? <p style={{ whiteSpace: "pre-line" }}>{arbResult}</p> : null}

      <h3>我的流动性凭证</h3>
      {positions.length === 0 ? <p>还没有 NFT</p> : null}
      {positions.map((position) => (
        <p key={`${position.exchange}-${position.id}`}>
          交易所 {position.exchange} NFT {position.id}，池子 {position.poolId}，份额 {position.share}，存入 A {position.amountA}、B {position.amountB}，添加时间 {position.createdAt}
          <br />
          占池子 {position.poolPercent}%，本金现在可取回 A {position.nowA}（{position.diffA}）、B {position.nowB}（{position.diffB}）
          <br />
          已累计手续费收益：A {position.feeA}、B {position.feeB}（取回时一并领取）{" "}
          <button onClick={() => run(() => removeLiquidity(position.exchange, position.id))}>取回</button>
        </p>
      ))}

      <p>{status}</p>
    </div>
  );
}

export default App;
