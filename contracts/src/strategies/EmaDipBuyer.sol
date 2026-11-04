// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// @notice Firm B: mean reversion. Tracks a private EMA of the price in enclave
///         memory and buys a slice whenever price trades `dipBps` below it.
/// state = abi.encode(ema, alphaBps, dipBps, sliceBase, maxPositionBase, cooldownBlocks, lastFireBlock)
contract EmaDipBuyer is StrategyBase {
    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        (uint256 ema, uint256 alpha, uint256 dip, uint256 slice, uint256 maxPos, uint256 cooldown, uint256 last) =
            abi.decode(state, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        uint256 px = _price(ctx);
        uint256 newEma = ema == 0 ? px : (px * alpha + ema * (10_000 - alpha)) / 10_000;

        Order memory order;
        bool dipped = ema != 0 && px * 10_000 < ema * (10_000 - dip);
        if (dipped && ctx.blockNumber >= last + cooldown) {
            uint256 bal = _baseBal(ctx);
            uint256 room = bal >= maxPos ? 0 : maxPos - bal;
            uint256 size = _min(_min(slice, room), _affordable(ctx, px));
            if (!_isDust(size, slice)) {
                order = Order(true, size);
                last = ctx.blockNumber;
            }
        }
        return (order, abi.encode(newEma, alpha, dip, slice, maxPos, cooldown, last));
    }
}
