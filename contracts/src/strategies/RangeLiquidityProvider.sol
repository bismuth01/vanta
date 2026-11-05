// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// @title Range Liquidity Provider (demo "bring your own strategy")
/// @notice Provides liquidity at the edges of a range that only you know:
///           • price < BUY_BELOW  → buy SLICE (absorbs panic selling)
///           • price > SELL_ABOVE → sell SLICE (feeds breakout buyers)
///         Inside the dark pool these orders cross against other firms at the oracle price:
///         zero slippage, zero AMM fees, and nothing for an MEV bot to front-run, because the
///         levels below are sealed inside the enclave. As a public contract, BUY_BELOW and
///         SELL_ABOVE would be a free signal to every searcher on Monad.
/// @dev    Sealed strategies never run a constructor: tune the constants, recompile, re-seal.
///         `state` is private memory kept by the enclave between blocks.
contract RangeLiquidityProvider is StrategyBase {
    uint256 constant BUY_BELOW = 2.88e18; // USDC per MON
    uint256 constant SELL_ABOVE = 3.25e18;
    uint256 constant SLICE = 800e18; // MON per fill
    uint256 constant MIN_INVENTORY = 2_000e18; // never sell below this many MON
    uint256 constant MAX_INVENTORY = 18_000e18; // never buy above this many MON
    uint256 constant COOLDOWN_BLOCKS = 1;

    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        // private state: (lastFireBlock, fills)
        (uint256 lastFire, uint256 fills) = state.length == 0 ? (0, 0) : abi.decode(state, (uint256, uint256));
        if (ctx.blockNumber < lastFire + COOLDOWN_BLOCKS) return _none(state);

        uint256 px = _price(ctx);
        uint256 inventory = _baseBal(ctx);
        Order memory order;

        if (px < BUY_BELOW && inventory < MAX_INVENTORY) {
            uint256 size = _min(_min(SLICE, MAX_INVENTORY - inventory), _affordable(ctx, px));
            if (!_isDust(size, SLICE)) order = Order(true, size);
        } else if (px > SELL_ABOVE && inventory > MIN_INVENTORY) {
            uint256 size = _min(SLICE, inventory - MIN_INVENTORY);
            if (!_isDust(size, SLICE)) order = Order(false, size);
        }

        if (order.baseAmount == 0) return _none(state);
        return (order, abi.encode(ctx.blockNumber, fills + 1));
    }
}
