// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Evaluator
/// @notice Never deployed. The enclave injects this code with an eth_call state override and
///         uses it to run every sealed strategy (and a few plain reads) in ONE call per block.
///         Unlike Multicall3, each call gets its own gas cap, so a guest strategy that loops or
///         reverts cannot starve the others, and per-strategy gas usage is reported back.
contract Evaluator {
    struct Call {
        address target;
        uint256 gasLimit;
        bytes data;
    }

    struct Result {
        bool success;
        uint256 gasUsed;
        bytes data;
    }

    uint256 internal constant MAX_RETURN = 4096;

    function run(Call[] calldata calls) external returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            uint256 g = gasleft();
            (bool ok, bytes memory ret) = calls[i].target.staticcall{gas: calls[i].gasLimit}(calls[i].data);
            uint256 used = g - gasleft();
            if (ret.length > MAX_RETURN) (ok, ret) = (false, "");
            results[i] = Result(ok, used, ret);
        }
    }
}
