// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyERC20 is ERC20 {
    // 创建这对代币的 MiniDEX 是唯一铸币地址，用来给两套交易所的固定池注入初始流动性。
    address public minter;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        _mint(to, amount);
    }
    
    function airdrop() external {
        _mint(msg.sender, 500 * 10**18); // 可以修改领取token A和 B的数量
    }
}