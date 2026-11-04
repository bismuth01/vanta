// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// @notice Firm C: momentum. Accumulates up to `targetBase` once price breaks out
///         above `trigger`, one slice per `cooldown` blocks.
/// state = abi.encode(trigger, sliceBase, targetBase, cooldownBlocks, lastFireBlock)
contract MomentumBreakout is StrategyBase {
    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        (uint256 trigger, uint256 slice, uint256 target, uint256 cooldown, uint256 last) =
            abi.decode(state, (uint256, uint256, uint256, uint256, uint256));
        uint256 px = _price(ctx);
        if (px <= trigger || ctx.blockNumber < last + cooldown) return _none(state);

        uint256 bal = _baseBal(ctx);
        if (bal >= target) return _none(state);
        uint256 size = _min(_min(slice, target - bal), _affordable(ctx, px));
        if (_isDust(size, slice)) return _none(state);
        return (Order(true, size), abi.encode(trigger, slice, target, cooldown, ctx.blockNumber));
    }
}
