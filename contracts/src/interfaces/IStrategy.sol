// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Snapshot handed to every sealed strategy, once per block, inside the enclave.
struct Context {
    uint256 blockNumber;
    uint256 timestamp;
    address firm; // the firm's DarkPool account
    address pool; // DarkPool (read balances via balanceOf(firm, token))
    address oracle; // IPriceOracle
    address amm; // SimpleAMM (public venue for residual flow)
    address base; // e.g. WMON
    address quote; // e.g. USDC
}

/// @notice A strategy's intent for this block. baseAmount == 0 means "do nothing".
struct Order {
    bool isBuy;
    uint256 baseAmount; // 18 decimals
}

/// @notice The interface firms implement. The contract is NEVER deployed on-chain:
///         its runtime bytecode is encrypted to the enclave key and executed off-chain
///         against live Monad state via eth_call + state override.
/// @dev    - Constructors and immutables do not run; put parameters in `state`.
///         - `state` is private memory persisted by the enclave between blocks.
interface IStrategy {
    function check(Context calldata ctx, bytes calldata state)
        external
        view
        returns (Order memory order, bytes memory newState);
}

interface IPriceOracle {
    /// @return price quote per base, 18 decimals
    /// @return updatedBlock block number of the last update
    function latest() external view returns (uint256 price, uint256 updatedBlock);
}

interface IDarkPoolBalances {
    function balanceOf(address firm, address token) external view returns (uint256);
}
