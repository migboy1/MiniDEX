// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "./MyERC20.sol";

contract MiniDEX is ERC721 {
    event PoolCreated(uint256 poolId, address tokenA, address tokenB);

    uint256 private constant ACC_PRECISION = 1e18;

    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;      // 参与定价的储备，不包含未领取的手续费
        uint256 reserveB;
        uint256 createdTimestamp;
        uint256 totalShare;
        uint256 accFeeA;       // 每 1 份额累计的 A 手续费（乘以 ACC_PRECISION）
        uint256 accFeeB;       // 每 1 份额累计的 B 手续费（乘以 ACC_PRECISION）
    }

    struct Position {
        uint256 poolId;
        uint256 share;
        uint256 amountA;
        uint256 amountB;
        uint256 createdTimestamp;
        uint256 feeDebtA;      // 添加流动性时已经累计的手续费，不属于这个凭证
        uint256 feeDebtB;
    }

    mapping(uint256 => Pool) public pools;
    uint256 public poolCount;
    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId;

    address public manager;
    MyERC20 public tokenA;
    MyERC20 public tokenB;
    bool public seedMinted;

    // tokenA_ 为零地址时，本合约创建代币并建立自己的固定池：100 A : 100 B。
    // 传入已有代币时，成为使用同一对代币的另一套交易所，固定池由 seedFixedPool 建立。
    constructor(address tokenA_, address tokenB_) ERC721("Liquidity Position", "LP") {
        manager = msg.sender;
        if (tokenA_ == address(0)) {
            tokenA = new MyERC20("TokenA", "TKA");
            tokenB = new MyERC20("TokenB", "TKB");
            _seedFixedPool(100 * 10 ** 18, 100 * 10 ** 18);
        } else {
            require(tokenB_ != address(0) && tokenA_ != tokenB_, "token");
            tokenA = MyERC20(tokenA_);
            tokenB = MyERC20(tokenB_);
        }
    }

    // 只给另一套交易所铸一次底仓。代币的铸币权在创建它们的那套交易所上。
    function mintForExchange(address to, uint256 amountA, uint256 amountB) external {
        require(msg.sender == manager, "not manager");
        require(!seedMinted, "seeded");
        require(to != address(0) && amountA > 0 && amountB > 0, "seed");
        seedMinted = true;
        tokenA.mint(to, amountA);
        tokenB.mint(to, amountB);
    }

    // 使用已经转到本合约的代币建立固定池，凭证留在合约里，用户不能取走底仓。
    function seedFixedPool(uint256 amountA, uint256 amountB) external {
        require(msg.sender == manager, "not manager");
        require(poolCount == 0, "pool exists");
        require(tokenA.balanceOf(address(this)) >= amountA && tokenB.balanceOf(address(this)) >= amountB, "seed balance");
        _openPool(address(tokenA), address(tokenB), amountA, amountB, address(this));
    }

    function _seedFixedPool(uint256 amountA, uint256 amountB) internal {
        tokenA.mint(address(this), amountA);
        tokenB.mint(address(this), amountB);
        _openPool(address(tokenA), address(tokenB), amountA, amountB, address(this));
    }

    function _openPool(
        address token_A,
        address token_B,
        uint256 initialAmountA,
        uint256 initialAmountB,
        address lpOwner
    ) internal {
        uint256 poolId = poolCount;
        pools[poolId] = Pool(token_A, token_B, initialAmountA, initialAmountB, block.timestamp, initialAmountA, 0, 0);
        poolCount += 1;

        uint256 positionId = nextPositionId;
        positions[positionId] = Position(poolId, initialAmountA, initialAmountA, initialAmountB, block.timestamp, 0, 0);
        nextPositionId += 1;
        // 铸给合约自身时不能用 _safeMint，本合约没有实现接收 NFT 的回调。
        if (lpOwner == address(this)) {
            _mint(lpOwner, positionId);
        } else {
            _safeMint(lpOwner, positionId);
        }

        emit PoolCreated(poolId, token_A, token_B);
    }

    function createPool(address token_A, address token_B, uint256 initialAmountA, uint256 initialAmountB) external {
        require(token_A != address(0) && token_B != address(0), "Invalid token address");
        require(token_A != token_B, "Token addresses must be different");
        require(initialAmountA > 0 && initialAmountB > 0, "Initial amount must be positive");
        require(MyERC20(token_A).balanceOf(msg.sender) >= initialAmountA && MyERC20(token_B).balanceOf(msg.sender) >= initialAmountB, "Insufficient balance");
        MyERC20(token_A).transferFrom(msg.sender, address(this), initialAmountA);
        MyERC20(token_B).transferFrom(msg.sender, address(this), initialAmountB);
        _openPool(token_A, token_B, initialAmountA, initialAmountB, msg.sender);
    }

    function exchange(uint256 poolId, address tokenIn, uint256 amountIn) external {
        require(poolId < poolCount, "Invalid pool id");
        require(tokenIn == pools[poolId].tokenA || tokenIn == pools[poolId].tokenB, "Invalid token address");
        require(MyERC20(tokenIn).balanceOf(msg.sender) >= amountIn, "Insufficient balance");

        MyERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 fee = amountIn * 3 / 1000;
        uint256 netIn = amountIn - fee;
        if (tokenIn == pools[poolId].tokenA) {
            uint256 amountOut = pools[poolId].reserveB * netIn / (pools[poolId].reserveA + netIn);
            pools[poolId].reserveA += netIn;
            pools[poolId].reserveB -= amountOut;
            pools[poolId].accFeeA += fee * ACC_PRECISION / pools[poolId].totalShare;
            MyERC20(pools[poolId].tokenB).transfer(msg.sender, amountOut);
        } else {
            uint256 amountOut = pools[poolId].reserveA * netIn / (pools[poolId].reserveB + netIn);
            pools[poolId].reserveA -= amountOut;
            pools[poolId].reserveB += netIn;
            pools[poolId].accFeeB += fee * ACC_PRECISION / pools[poolId].totalShare;
            MyERC20(pools[poolId].tokenA).transfer(msg.sender, amountOut);
        }
    }

    function addLiquidity(uint256 poolId, uint256 amountToken, address token) external {
        require(poolId < poolCount, "Invalid pool id");
        require(token == pools[poolId].tokenA || token == pools[poolId].tokenB, "Invalid token address");
        require(amountToken > 0, "Amount must be positive");

        uint256 amountA;
        uint256 amountB;
        if (token == pools[poolId].tokenA) {
            amountA = amountToken;
            amountB = amountA * pools[poolId].reserveB / pools[poolId].reserveA;
        } else {
            amountB = amountToken;
            amountA = amountB * pools[poolId].reserveA / pools[poolId].reserveB;
        }
        require(amountA > 0 && amountB > 0, "Amount too small");

        uint256 share = amountA * pools[poolId].totalShare / pools[poolId].reserveA;
        require(share > 0, "Share too small");

        MyERC20(pools[poolId].tokenA).transferFrom(msg.sender, address(this), amountA);
        MyERC20(pools[poolId].tokenB).transferFrom(msg.sender, address(this), amountB);

        pools[poolId].reserveA += amountA;
        pools[poolId].reserveB += amountB;
        pools[poolId].totalShare += share;

        uint256 positionId = nextPositionId;
        positions[positionId] = Position(
            poolId,
            share,
            amountA,
            amountB,
            block.timestamp,
            share * pools[poolId].accFeeA / ACC_PRECISION,
            share * pools[poolId].accFeeB / ACC_PRECISION
        );
        nextPositionId += 1;
        _safeMint(msg.sender, positionId);
    }

    // 某个凭证目前累计的、可以领取的手续费。
    function pendingFees(uint256 positionId) public view returns (uint256 feeA, uint256 feeB) {
        require(positionId < nextPositionId, "Invalid position id");
        Position memory position = positions[positionId];
        Pool memory pool = pools[position.poolId];
        feeA = position.share * pool.accFeeA / ACC_PRECISION - position.feeDebtA;
        feeB = position.share * pool.accFeeB / ACC_PRECISION - position.feeDebtB;
    }

    function removeLiquidity(uint256 positionId) external {
        require(positionId < nextPositionId, "Invalid position id");
        require(ownerOf(positionId) == msg.sender, "Not the position owner");

        uint256 poolId = positions[positionId].poolId;
        uint256 share = positions[positionId].share;
        require(share > 0, "Empty position");

        (uint256 feeA, uint256 feeB) = pendingFees(positionId);

        uint256 amountA = pools[poolId].reserveA * share / pools[poolId].totalShare;
        uint256 amountB = pools[poolId].reserveB * share / pools[poolId].totalShare;

        pools[poolId].reserveA -= amountA;
        pools[poolId].reserveB -= amountB;
        pools[poolId].totalShare -= share;
        _burn(positionId);

        // 本金按份额取回，手续费另外加上。
        MyERC20(pools[poolId].tokenA).transfer(msg.sender, amountA + feeA);
        MyERC20(pools[poolId].tokenB).transfer(msg.sender, amountB + feeB);
    }
}
