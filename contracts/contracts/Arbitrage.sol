// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IMiniDEX {
    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 createdTimestamp;
        uint256 totalShare;
        uint256 accFeeA;
        uint256 accFeeB;
    }

    function poolCount() external view returns (uint256);
    function pools(uint256 poolId) external view returns (Pool memory);
    function exchange(uint256 poolId, address tokenIn, uint256 amountIn) external;
}

// 在同一笔交易里，把 A 拿到价格更高的池子换成 B，再把 B 拿到价格更低的池子换回 A。
// 换回的 A 不超过投入时整笔回滚，两跳兑换都不会留下。
contract Arbitrage {
    struct Plan {
        address dexSell;
        address dexBuy;
        uint256 poolSell;
        uint256 poolBuy;
        uint256 priceSell;
        uint256 priceBuy;
        uint256 amountBMid;
        uint256 amountAOut;
        uint256 profitA;
        address tokenA;
        address tokenB;
    }

    event ArbitrageExecuted(
        address indexed trader,
        address dexSell,
        address dexBuy,
        uint256 poolSell,
        uint256 poolBuy,
        uint256 amountAIn,
        uint256 amountBMid,
        uint256 amountAOut,
        uint256 profitA
    );

    function quote(address dex0, uint256 pool0, address dex1, uint256 pool1, uint256 amountAIn)
        external
        view
        returns (
            address dexSell,
            address dexBuy,
            uint256 poolSell,
            uint256 poolBuy,
            uint256 priceSell,
            uint256 priceBuy,
            uint256 amountBMid,
            uint256 amountAOut,
            uint256 profitA
        )
    {
        Plan memory plan = _prepare(dex0, pool0, dex1, pool1, amountAIn);
        dexSell = plan.dexSell;
        dexBuy = plan.dexBuy;
        poolSell = plan.poolSell;
        poolBuy = plan.poolBuy;
        priceSell = plan.priceSell;
        priceBuy = plan.priceBuy;
        amountBMid = plan.amountBMid;
        amountAOut = plan.amountAOut;
        profitA = plan.profitA;
    }

    function execute(address dex0, uint256 pool0, address dex1, uint256 pool1, uint256 amountAIn) external returns (uint256 profitA) {
        Plan memory plan = _prepare(dex0, pool0, dex1, pool1, amountAIn);
        require(plan.profitA > 0, "no profit");
        profitA = _swap(plan, amountAIn);
    }

    function _swap(Plan memory plan, uint256 amountAIn) internal returns (uint256 profitA) {
        IERC20(plan.tokenA).transferFrom(msg.sender, address(this), amountAIn);
        IERC20(plan.tokenA).approve(plan.dexSell, amountAIn);
        uint256 bBefore = IERC20(plan.tokenB).balanceOf(address(this));
        IMiniDEX(plan.dexSell).exchange(plan.poolSell, plan.tokenA, amountAIn);

        uint256 amountBMid = IERC20(plan.tokenB).balanceOf(address(this)) - bBefore;
        IERC20(plan.tokenB).approve(plan.dexBuy, amountBMid);
        IMiniDEX(plan.dexBuy).exchange(plan.poolBuy, plan.tokenB, amountBMid);

        uint256 amountAOut = IERC20(plan.tokenA).balanceOf(address(this));
        require(amountAOut > amountAIn, "no profit");
        profitA = amountAOut - amountAIn;
        IERC20(plan.tokenA).transfer(msg.sender, amountAOut);
        _emitResult(plan, amountAIn, amountBMid, amountAOut, profitA);
    }

    function _emitResult(
        Plan memory plan,
        uint256 amountAIn,
        uint256 amountBMid,
        uint256 amountAOut,
        uint256 profitA
    ) internal {
        emit ArbitrageExecuted(
            msg.sender,
            plan.dexSell,
            plan.dexBuy,
            plan.poolSell,
            plan.poolBuy,
            amountAIn,
            amountBMid,
            amountAOut,
            profitA
        );
    }

    function _prepare(address dex0, uint256 pool0, address dex1, uint256 pool1, uint256 amountAIn)
        internal
        view
        returns (Plan memory plan)
    {
        require(amountAIn > 0, "amount");
        require(dex0 != dex1 || pool0 != pool1, "same pool");
        IMiniDEX.Pool memory first = _pool(dex0, pool0);
        IMiniDEX.Pool memory second = _pool(dex1, pool1);
        require(first.tokenA == second.tokenA && first.tokenB == second.tokenB, "different pair");

        uint256 price0 = _price(first.reserveA, first.reserveB);
        uint256 price1 = _price(second.reserveA, second.reserveB);
        require(price0 != price1, "no price difference");

        IMiniDEX.Pool memory sellPool;
        IMiniDEX.Pool memory buyPool;
        if (price0 > price1) {
            plan.dexSell = dex0;
            plan.dexBuy = dex1;
            plan.poolSell = pool0;
            plan.poolBuy = pool1;
            sellPool = first;
            buyPool = second;
        } else {
            plan.dexSell = dex1;
            plan.dexBuy = dex0;
            plan.poolSell = pool1;
            plan.poolBuy = pool0;
            sellPool = second;
            buyPool = first;
        }

        plan.tokenA = sellPool.tokenA;
        plan.tokenB = sellPool.tokenB;
        plan.priceSell = _price(sellPool.reserveA, sellPool.reserveB);
        plan.priceBuy = _price(buyPool.reserveA, buyPool.reserveB);
        // 第一跳只改变卖出池，买入池的储备仍用报价时的数量。
        plan.amountBMid = _amountOut(sellPool.reserveA, sellPool.reserveB, amountAIn);
        plan.amountAOut = _amountOut(buyPool.reserveB, buyPool.reserveA, plan.amountBMid);
        if (plan.amountAOut > amountAIn) {
            plan.profitA = plan.amountAOut - amountAIn;
        }
    }

    function _pool(address dex, uint256 poolId) internal view returns (IMiniDEX.Pool memory pool) {
        require(poolId < IMiniDEX(dex).poolCount(), "invalid pool");
        pool = IMiniDEX(dex).pools(poolId);
        require(pool.reserveA > 0 && pool.reserveB > 0, "empty pool");
    }

    // 价格是 1 个 A 能换多少 B，放大 1e18。
    function _price(uint256 reserveA, uint256 reserveB) internal pure returns (uint256) {
        return reserveB * 1e18 / reserveA;
    }

    // 与 MiniDEX.exchange 相同：先扣 0.3%，再按恒定乘积计算。
    function _amountOut(uint256 reserveIn, uint256 reserveOut, uint256 amountIn) internal pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) {
            return 0;
        }
        uint256 fee = amountIn * 3 / 1000;
        if (fee >= amountIn) {
            return 0;
        }
        uint256 netIn = amountIn - fee;
        return reserveOut * netIn / (reserveIn + netIn);
    }
}
