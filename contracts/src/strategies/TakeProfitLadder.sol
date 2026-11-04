// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// @notice Firm D: distributes inventory into strength above `trigger`, keeping
///         at least `floorBase`, one slice per `cooldown` blocks.
/// state = abi.encode(trigger, sliceBase, floorBase, cooldownBlocks, lastFireBlock)
contract TakeProfitLadder is StrategyBase {
    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        (uint256 trigger, uint256 slice, uint256 floor, uint256 cooldown, uint256 last) =
            abi.decode(state, (uint256, uint256, uint256, uint256, uint256));
        if (_price(ctx) <= trigger || ctx.blockNumber < last + cooldown) return _none(state);

        uint256 bal = _baseBal(ctx);
        if (bal <= floor) return _none(state);
        return (Order(false, _min(slice, bal - floor)), abi.encode(trigger, slice, floor, cooldown, ctx.blockNumber));
    }
}
