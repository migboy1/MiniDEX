# MiniDEX 合约工程

使用 Hardhat 3、ethers 6 和 TypeScript。`contracts/MiniDEX.sol` 目前仅是 Demo，DEX 功能尚待实现。

## 安装与检查

建议使用 Node.js 24。在 `contracts/` 目录执行：

```bash
nvm install
nvm use
npm ci
npm run compile
npm run typecheck
npm test
```

`npm run build` 与 `npm run compile` 等效。类型检查会先编译合约并生成类型。当前 Solidity 编译器为 0.8.20，OpenZeppelin 使用兼容该编译器的稳定版 5.4.0。

## 在本地 Hardhat 节点上部署

先启动节点，并保持该终端开启：

```bash
npm run node
```

在另一个终端进入 `contracts/`，使用相同的 Node.js 版本后执行：

```bash
npm run deploy
```

默认 RPC 地址为 `http://127.0.0.1:8545`，Chain ID 为 `31337`。部署脚本输出 MiniDEX 合约地址；ABI 位于 `artifacts/contracts/MiniDEX.sol/MiniDEX.json`。

## 在 Ganache 上部署

启动 Ganache，在 `hardhat.config.ts` 中调整 `ganache.url` 以匹配其 RPC 地址，然后执行：

```bash
npm run deploy:ganache
```

也可以通过环境变量 `LOCAL_RPC_URL` 或 `GANACHE_RPC_URL` 覆盖对应的 RPC 地址。部署使用节点提供的已解锁测试账户。

使用临时内存链测试部署脚本时，可执行 `npx hardhat run scripts/deploy.ts --network hardhat`。
