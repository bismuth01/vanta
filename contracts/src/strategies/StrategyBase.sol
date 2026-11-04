// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategy, Context, Order, IPriceOracle, IDarkPoolBalances} from "../interfaces/IStrategy.sol";

/// @notice Helpers for sealed strategies. Everything here reads LIVE chain state
///         at the block the enclave is evaluating.
abstract contract StrategyBase is IStrategy {
    function _price(Context calldata ctx) internal view returns (uint256 px) {
        (px,) = IPriceOracle(ctx.oracle).latest();
    }

    function _baseBal(Context calldata ctx) internal view returns (uint256) {
        return IDarkPoolBalances(ctx.pool).balanceOf(ctx.firm, ctx.base);
    }

    function _quoteBal(Context calldata ctx) internal view returns (uint256) {
        return IDarkPoolBalances(ctx.pool).balanceOf(ctx.firm, ctx.quote);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev Largest buy (in base) affordable with the firm's quote balance, with 1% headroom.
    function _affordable(Context calldata ctx, uint256 px) internal view returns (uint256) {
        return _quoteBal(ctx) * 1e18 / px * 99 / 100;
    }

    /// @dev Skip orders below 10% of a slice: on Monad every tx pays its full gas limit.
    function _isDust(uint256 size, uint256 slice) internal pure returns (bool) {
        return size * 10 < slice;
    }

    function _none(bytes memory state) internal pure returns (Order memory, bytes memory) {
        return (Order(false, 0), state);
    }
}
