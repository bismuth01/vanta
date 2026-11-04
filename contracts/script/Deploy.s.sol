// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DarkPool} from "../src/DarkPool.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {SimpleAMM} from "../src/mocks/SimpleAMM.sol";

/// forge script script/Deploy.s.sol --rpc-url local --broadcast --private-key $DEPLOYER_PK
/// env: ORACLE_UPDATER (market-sim account), INITIAL_PRICE (1e18, default 3e18)
contract Deploy is Script {
    function run() external {
        address updater = vm.envAddress("ORACLE_UPDATER");
        uint256 initialPrice = vm.envOr("INITIAL_PRICE", uint256(3e18));

        vm.startBroadcast();
        MockERC20 wmon = new MockERC20("Wrapped MON", "WMON");
        MockERC20 usdc = new MockERC20("USD Coin", "USDC");
        MockOracle oracle = new MockOracle(updater, initialPrice);
        SimpleAMM amm = new SimpleAMM(address(wmon), address(usdc));
        EnclaveRegistry registry = new EnclaveRegistry();
        DarkPool pool = new DarkPool(address(wmon), address(usdc), oracle, amm, registry);

        uint256 liqBase = 1_000_000e18;
        uint256 liqQuote = liqBase * initialPrice / 1e18;
        wmon.mint(msg.sender, liqBase);
        usdc.mint(msg.sender, liqQuote);
        wmon.approve(address(amm), liqBase);
        usdc.approve(address(amm), liqQuote);
        amm.addLiquidity(liqBase, liqQuote);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "base", address(wmon));
        vm.serializeAddress(k, "quote", address(usdc));
        vm.serializeAddress(k, "oracle", address(oracle));
        vm.serializeAddress(k, "amm", address(amm));
        vm.serializeAddress(k, "registry", address(registry));
        string memory json = vm.serializeAddress(k, "pool", address(pool));
        // forge also runs this in simulation: only record addresses for a real broadcast.
        if (!vm.envOr("WRITE_DEPLOYMENT", false)) return console.log("simulation: deployments file not written");
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("DarkPool", address(pool));
        console.log("written", path);
    }
}
