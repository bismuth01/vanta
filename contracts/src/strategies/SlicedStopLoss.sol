// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// @notice Firm A: protect a long position. Once price breaks `stopPrice`, exit in
///         slices every block (an iceberg). In a public contract the stop level is a
///         free signal for front-runners; sealed, nobody knows where it sits.
/// state = abi.encode(uint256 stopPrice, uint256 sliceBase)
contract SlicedStopLoss is StrategyBase {
    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        (uint256 stopPrice, uint256 slice) = abi.decode(state, (uint256, uint256));
        uint256 bal = _baseBal(ctx);
        if (_price(ctx) >= stopPrice || bal == 0) return _none(state);
        return (Order(false, _min(slice, bal)), state);
    }
}
