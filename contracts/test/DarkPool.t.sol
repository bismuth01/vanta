// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DarkPool} from "../src/DarkPool.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {SimpleAMM} from "../src/mocks/SimpleAMM.sol";
import {Context, Order} from "../src/interfaces/IStrategy.sol";
import {SlicedStopLoss} from "../src/strategies/SlicedStopLoss.sol";
import {EmaDipBuyer} from "../src/strategies/EmaDipBuyer.sol";
import {Evaluator} from "../src/engine/Evaluator.sol";
import {RangeLiquidityProvider} from "../src/strategies/RangeLiquidityProvider.sol";

contract DarkPoolTest is Test {
    MockERC20 wmon;
    MockERC20 usdc;
    MockOracle oracle;
    SimpleAMM amm;
    EnclaveRegistry registry;
    DarkPool pool;

    bytes32 constant MEASUREMENT = keccak256("vanta-enclave-v1");
    uint256 enclavePk = 0xE11C1A7E;
    address enclave;
    address firmA = makeAddr("firmA");
    address firmB = makeAddr("firmB");
    bytes32 constant COMMIT_A = keccak256("A");
    bytes32 constant COMMIT_B = keccak256("B");
    bytes32 STRAT_A;
    bytes32 STRAT_B;

    uint256 constant PX = 3e18;

    function setUp() public {
        enclave = vm.addr(enclavePk);
        wmon = new MockERC20("Wrapped MON", "WMON");
        usdc = new MockERC20("USD Coin", "USDC");
        oracle = new MockOracle(address(this), PX);
        amm = new SimpleAMM(address(wmon), address(usdc));
        registry = new EnclaveRegistry();
        pool = new DarkPool(address(wmon), address(usdc), oracle, amm, registry);

        wmon.mint(address(this), 1_000_000e18);
        usdc.mint(address(this), 3_000_000e18);
        wmon.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        amm.addLiquidity(1_000_000e18, 3_000_000e18);

        registry.approveMeasurement(MEASUREMENT);
        bytes32 encKey = bytes32(uint256(0xC0FFEE));
        registry.registerEnclave(enclave, encKey, abi.encode(MEASUREMENT, keccak256(abi.encode(enclave, encKey))));

        STRAT_A = pool.strategyIdOf(firmA, COMMIT_A);
        STRAT_B = pool.strategyIdOf(firmB, COMMIT_B);
        _fund(firmA, 10_000e18, 0, COMMIT_A);
        _fund(firmB, 0, 30_000e18, COMMIT_B);
    }

    function _fund(address firm, uint256 baseAmt, uint256 quoteAmt, bytes32 strat) internal {
        wmon.mint(firm, baseAmt);
        usdc.mint(firm, quoteAmt);
        vm.startPrank(firm);
        wmon.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        if (baseAmt > 0) pool.deposit(address(wmon), baseAmt);
        if (quoteAmt > 0) pool.deposit(address(usdc), quoteAmt);
        pool.setRiskLimit(100_000e18);
        pool.registerStrategy(strat);
        vm.stopPrank();
    }

    function _batch(uint256 id, DarkPool.Fill[] memory fills) internal view returns (DarkPool.Batch memory b) {
        b = DarkPool.Batch({batchId: id, validUntilBlock: block.number + 2, price: PX, fills: fills});
    }

    function _sign(DarkPool.Batch memory b, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(block.chainid, address(pool), b));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _fills2(bool aBuy, uint256 aAmt, bool bBuy, uint256 bAmt) internal view returns (DarkPool.Fill[] memory f) {
        f = new DarkPool.Fill[](2);
        f[0] = DarkPool.Fill(STRAT_A, aBuy, aAmt);
        f[1] = DarkPool.Fill(STRAT_B, bBuy, bAmt);
    }

    function test_fullCross_noAmmTouch() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1_000e18, true, 1_000e18));
        uint256 ammBaseBefore = amm.reserveBase();
        pool.settle(b, _sign(b, enclavePk));

        assertEq(amm.reserveBase(), ammBaseBefore, "AMM untouched");
        assertEq(pool.balanceOf(firmA, address(wmon)), 9_000e18);
        assertEq(pool.balanceOf(firmA, address(usdc)), 3_000e18);
        assertEq(pool.balanceOf(firmB, address(wmon)), 1_000e18);
        assertEq(pool.balanceOf(firmB, address(usdc)), 27_000e18);
        assertEq(pool.cumulativeCrossedBase(), 1_000e18);
    }

    function test_partialCross_residualRoutedToAmm() public {
        // A sells 4,000, B buys 1,000 → 1,000 crossed, 3,000 routed to AMM
        DarkPool.Batch memory b = _batch(1, _fills2(false, 4_000e18, true, 1_000e18));
        pool.settle(b, _sign(b, enclavePk));

        assertEq(pool.balanceOf(firmA, address(wmon)), 6_000e18);
        assertEq(pool.balanceOf(firmB, address(wmon)), 1_000e18);
        uint256 aQuote = pool.balanceOf(firmA, address(usdc));
        // 1,000 @ 3.00 crossed + ~3,000 @ ~2.98 via AMM (fee + impact)
        assertGt(aQuote, 11_900e18);
        assertLt(aQuote, 12_000e18);
        assertEq(pool.cumulativeRoutedBase(), 3_000e18);
    }

    function test_ledgerSolvent_withRounding() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1_234_567_891_234_567_891, true, 777_777_777_777_777_777));
        pool.settle(b, _sign(b, enclavePk));
        uint256 owedBase = pool.balanceOf(firmA, address(wmon)) + pool.balanceOf(firmB, address(wmon));
        uint256 owedQuote = pool.balanceOf(firmA, address(usdc)) + pool.balanceOf(firmB, address(usdc));
        assertGe(wmon.balanceOf(address(pool)), owedBase, "base solvent");
        assertGe(usdc.balanceOf(address(pool)), owedQuote, "quote solvent");
    }

    function test_revert_unattestedSigner() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1e18, true, 1e18));
        bytes memory sig = _sign(b, 0xBAD);
        vm.expectRevert("unattested signer");
        pool.settle(b, sig);
    }

    function test_revert_replay() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1e18, true, 1e18));
        bytes memory sig = _sign(b, enclavePk);
        pool.settle(b, sig);
        vm.expectRevert("batch replay");
        pool.settle(b, sig);
    }

    function test_revert_expired() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1e18, true, 1e18));
        bytes memory sig = _sign(b, enclavePk);
        vm.roll(block.number + 3);
        vm.expectRevert("batch expired");
        pool.settle(b, sig);
    }

    function test_revert_priceOutsideOracleBand() public {
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1e18, true, 1e18));
        b.price = PX * 102 / 100; // malicious enclave tries to cross 2% off-market
        bytes memory sig = _sign(b, enclavePk);
        vm.expectRevert("price outside oracle band");
        pool.settle(b, sig);
    }

    function test_riskLimit_rejectsFillButBatchSettles() public {
        vm.prank(firmA);
        pool.setRiskLimit(100e18); // max 100 USDC per batch
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1_000e18, true, 1_000e18));
        pool.settle(b, _sign(b, enclavePk));
        // A rejected; B's buy fully routed to AMM instead
        assertEq(pool.balanceOf(firmA, address(wmon)), 10_000e18);
        assertGt(pool.balanceOf(firmB, address(wmon)), 990e18);
        assertEq(pool.cumulativeCrossedBase(), 0);
    }

    function test_revoke_disablesEnclave() public {
        registry.revoke(enclave);
        DarkPool.Batch memory b = _batch(1, _fills2(false, 1e18, true, 1e18));
        bytes memory sig = _sign(b, enclavePk);
        vm.expectRevert("unattested signer");
        pool.settle(b, sig);
    }

    function test_registerStrategyWithLimit_oneTx() public {
        address guest = makeAddr("guest");
        vm.prank(guest);
        bytes32 id = pool.registerStrategyWithLimit(keccak256("guest-code"), 5_000e18);
        (address owner, bool active,) = pool.strategies(id);
        assertEq(owner, guest);
        assertTrue(active);
        assertEq(pool.maxNotionalPerBatch(guest), 5_000e18);
        assertEq(id, pool.strategyIdOf(guest, keccak256("guest-code")));
    }

    function test_sameCommitment_differentFirms_noSquatting() public {
        address other = makeAddr("other");
        vm.prank(other);
        bytes32 id = pool.registerStrategy(COMMIT_A); // same hash as firm A's: allowed, distinct id
        assertTrue(id != STRAT_A);
        (address ownerA,,) = pool.strategies(STRAT_A);
        assertEq(ownerA, firmA);
    }

    function test_depositFor_creditsTargetFirm() public {
        address guest = makeAddr("guest");
        usdc.mint(address(this), 1_000e18);
        usdc.approve(address(pool), 1_000e18);
        pool.depositFor(guest, address(usdc), 1_000e18);
        assertEq(pool.balanceOf(guest, address(usdc)), 1_000e18);
    }

    // ── sealed strategies: injected with vm.etch, exactly like the engine's eth_call state override ──
    function _ctx(address firm) internal view returns (Context memory) {
        return Context(block.number, block.timestamp, firm, address(pool), address(oracle), address(amm), address(wmon), address(usdc));
    }

    function test_sealedStopLoss_firesBelowStop() public {
        address phantom = address(0x5EA1ED);
        vm.etch(phantom, address(new SlicedStopLoss()).code);
        bytes memory state = abi.encode(uint256(2.85e18), uint256(1_000e18));

        (Order memory o,) = SlicedStopLoss(phantom).check(_ctx(firmA), state);
        assertEq(o.baseAmount, 0, "idle above stop");

        oracle.set(2.80e18);
        (o,) = SlicedStopLoss(phantom).check(_ctx(firmA), state);
        assertFalse(o.isBuy);
        assertEq(o.baseAmount, 1_000e18);
    }

    function test_sealedEmaDipBuyer_keepsPrivateState() public {
        address phantom = address(0x5EA1ED);
        vm.etch(phantom, address(new EmaDipBuyer()).code);
        bytes memory state = abi.encode(uint256(0), uint256(1_000), uint256(200), uint256(1_500e18), uint256(10_000e18), uint256(4), uint256(0));

        (Order memory o, bytes memory s1) = EmaDipBuyer(phantom).check(_ctx(firmB), state);
        assertEq(o.baseAmount, 0);
        (uint256 ema,,,,,,) = abi.decode(s1, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        assertEq(ema, PX, "ema seeded");

        oracle.set(2.85e18); // 5% below ema
        vm.roll(block.number + 10);
        (o,) = EmaDipBuyer(phantom).check(_ctx(firmB), s1);
        assertTrue(o.isBuy);
        assertEq(o.baseAmount, 1_500e18);
    }
}

contract Looper {
    function check(Context calldata, bytes calldata) external pure returns (Order memory, bytes memory) {
        for (;;) {}
    }
}

contract EvaluatorTest is Test {
    function test_gasCapIsolatesRunawayStrategy() public {
        Evaluator ev = new Evaluator();
        MockOracle oracle = new MockOracle(address(this), 3e18);
        Evaluator.Call[] memory calls = new Evaluator.Call[](2);
        calls[0] = Evaluator.Call(address(new Looper()), 200_000, abi.encodeWithSelector(Looper.check.selector));
        calls[1] = Evaluator.Call(address(oracle), 50_000, abi.encodeWithSelector(MockOracle.latest.selector));
        Evaluator.Result[] memory r = ev.run(calls);
        assertFalse(r[0].success, "runaway strategy fails");
        assertTrue(r[1].success, "others still run");
        (uint256 px,) = abi.decode(r[1].data, (uint256, uint256));
        assertEq(px, 3e18);
    }
}

contract RangeLiquidityProviderTest is Test {
    function test_buysDip_sellsRip_withEmptyInitialState() public {
        MockOracle oracle = new MockOracle(address(this), 3e18);
        MockBalances bal = new MockBalances();
        address phantom = address(0x5EA1ED);
        vm.etch(phantom, address(new RangeLiquidityProvider()).code);
        Context memory ctx = Context(100, 0, address(1), address(bal), address(oracle), address(0), address(2), address(3));
        bal.set(address(2), 10_000e18);
        bal.set(address(3), 30_000e18);

        (Order memory o, bytes memory s) = RangeLiquidityProvider(phantom).check(ctx, "");
        assertEq(o.baseAmount, 0, "idle inside the range");

        oracle.set(2.80e18);
        (o, s) = RangeLiquidityProvider(phantom).check(ctx, "");
        assertTrue(o.isBuy);
        assertEq(o.baseAmount, 800e18);
        (o,) = RangeLiquidityProvider(phantom).check(ctx, s);
        assertEq(o.baseAmount, 0, "cooldown in the same block");

        oracle.set(3.30e18);
        ctx.blockNumber = 101;
        (o,) = RangeLiquidityProvider(phantom).check(ctx, s);
        assertFalse(o.isBuy);
        assertEq(o.baseAmount, 800e18);
    }
}

contract MockBalances {
    mapping(address => uint256) internal b;
    function set(address token, uint256 v) external { b[token] = v; }
    function balanceOf(address, address token) external view returns (uint256) { return b[token]; }
}
