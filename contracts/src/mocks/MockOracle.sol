// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IStrategy.sol";

/// @notice Stand-in for a low-latency push oracle (Pyth Pro / RedStone Bolt on Monad).
contract MockOracle is IPriceOracle {
    address public immutable updater;
    uint256 public price;
    uint256 public updatedBlock;

    event PriceUpdated(uint256 price, uint256 blockNumber);

    constructor(address updater_, uint256 initialPrice) {
        updater = updater_;
        price = initialPrice;
        updatedBlock = block.number;
    }

    function set(uint256 newPrice) external {
        require(msg.sender == updater, "not updater");
        price = newPrice;
        updatedBlock = block.number;
        emit PriceUpdated(newPrice, block.number);
    }

    function latest() external view returns (uint256, uint256) {
        return (price, updatedBlock);
    }
}
