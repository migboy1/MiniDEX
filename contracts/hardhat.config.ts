import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.20",
    settings: {
      // 兼容教学中使用的 Ganache 节点。
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 1337,
    },
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 1337,
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
    ganache: {
      type: "http",
      chainType: "l1",
      url: process.env.GANACHE_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
  },
});
