// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle, IDarkPoolBalances} from "./interfaces/IStrategy.sol";
import {EnclaveRegistry} from "./EnclaveRegistry.sol";
import {SimpleAMM} from "./mocks/SimpleAMM.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title DarkPool
/// @notice Vault + settlement layer for sealed strategies.
///
///   Firms deposit into an internal ledger and register *commitments* (hashes) of
///   their strategies. Strategy code never touches the chain. Each block, the
///   attested enclave evaluates every strategy and submits one signed Batch:
///
///     1. Opposite orders are CROSSED internally at the oracle price: no AMM touch,
///        no price impact, nothing for a sandwich bot to see before it is final.
///     2. Only the net residual is ROUTED to the public AMM, with a contract-enforced
///        minOut derived from the oracle, so MEV on it is bounded by MAX_SLIPPAGE_BPS.
///
///   The contract trusts the enclave only as far as the guards below allow:
///   attested signer, replay protection, expiry block, oracle band, per-firm
///   risk limits, and balance escrow.
contract DarkPool is IDarkPoolBalances {
    // ─────────────────────────────── types ───────────────────────────────
    struct Fill {
        bytes32 strategyId; // keccak256(abi.encode(firm, keccak256(abi.encode(runtimeCode, initState))))
        bool isBuy;
        uint256 baseAmount;
    }

    struct Batch {
        uint256 batchId; // unique (enclave uses the evaluated block number)
        uint256 validUntilBlock; // Monad: use block.number, timestamps have 1s granularity
        uint256 price; // enclave-observed price, must sit inside the oracle band
        Fill[] fills;
    }

    struct StrategyInfo {
        address firm;
        bool active;
        uint64 registeredBlock;
    }

    struct Leg {
        address firm;
        bool ok;
        uint256 crossedBase; // base matched internally
        uint256 residualIn; // amount sent to the AMM (quote for buys, base for sells)
        uint256 routedOut; // amount received from the AMM
        uint256 quoteCrossed; // quote paid (buy) or received (sell) for the crossed part
        uint256 refund; // escrow rounding refund (quote, buys only)
    }

    // ─────────────────────────────── config ───────────────────────────────
    uint256 public constant ORACLE_BAND_BPS = 100; // enclave price within 1.00% of oracle
    uint256 public constant MAX_SLIPPAGE_BPS = 150; // routed residual within 1.50% of oracle
    uint256 public constant MAX_ORACLE_AGE_BLOCKS = 30; // ~9s at 300ms blocks

    address public immutable base;
    address public immutable quote;
    IPriceOracle public immutable oracle;
    SimpleAMM public immutable amm;
    EnclaveRegistry public immutable registry;

    // ─────────────────────────────── state ───────────────────────────────
    mapping(address firm => mapping(address token => uint256)) public balanceOf;
    mapping(bytes32 strategyId => StrategyInfo) public strategies;
    mapping(address firm => uint256) public maxNotionalPerBatch; // quote units; 0 = trading disabled
    mapping(uint256 batchId => bool) public batchUsed;

    uint256 public batchesSettled;
    uint256 public cumulativeCrossedBase;
    uint256 public cumulativeRoutedBase;

    // ─────────────────────────────── events ───────────────────────────────
    event Deposit(address indexed firm, address indexed token, uint256 amount);
    event Withdraw(address indexed firm, address indexed token, uint256 amount);
    event StrategyRegistered(address indexed firm, bytes32 indexed strategyId, bytes32 commitment);
    event StrategyStatus(bytes32 indexed strategyId, bool active);
    event RiskLimitSet(address indexed firm, uint256 maxNotionalPerBatch);
    event Filled(
        uint256 indexed batchId,
        bytes32 indexed strategyId,
        address indexed firm,
        bool isBuy,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 crossedBase
    );
    event FillRejected(uint256 indexed batchId, bytes32 indexed strategyId, uint8 reason);
    event BatchSettled(
        uint256 indexed batchId,
        address indexed enclave,
        uint256 price,
        uint256 crossedBase,
        uint256 routedIn,
        uint256 routedOut,
        bool routedIsBuy
    );

    uint8 internal constant REJECT_UNKNOWN_STRATEGY = 1;
    uint8 internal constant REJECT_ZERO = 2;
    uint8 internal constant REJECT_RISK_LIMIT = 3;
    uint8 internal constant REJECT_BALANCE = 4;

    constructor(address base_, address quote_, IPriceOracle oracle_, SimpleAMM amm_, EnclaveRegistry registry_) {
        base = base_;
        quote = quote_;
        oracle = oracle_;
        amm = amm_;
        registry = registry_;
        IERC20(base_).approve(address(amm_), type(uint256).max);
        IERC20(quote_).approve(address(amm_), type(uint256).max);
    }

    // ─────────────────────────────── firm API ───────────────────────────────
    function deposit(address token, uint256 amount) external {
        depositFor(msg.sender, token, amount);
    }

    /// @notice Credit any firm's vault (used by the demo faucet so guests need no token txs).
    function depositFor(address firm, address token, uint256 amount) public {
        _checkToken(token);
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOf[firm][token] += amount;
        emit Deposit(firm, token, amount);
    }

    function withdraw(address token, uint256 amount) external {
        _checkToken(token);
        balanceOf[msg.sender][token] -= amount;
        IERC20(token).transfer(msg.sender, amount);
        emit Withdraw(msg.sender, token, amount);
    }

    /// @notice strategyId binds a commitment to its firm, so nobody can squat someone else's hash.
    function strategyIdOf(address firm, bytes32 commitment) public pure returns (bytes32) {
        return keccak256(abi.encode(firm, commitment));
    }

    /// @notice Publish only a hash. The code itself goes encrypted to the enclave.
    /// @param commitment keccak256(abi.encode(runtimeCode, initState))
    function registerStrategy(bytes32 commitment) public returns (bytes32 strategyId) {
        strategyId = strategyIdOf(msg.sender, commitment);
        require(strategies[strategyId].firm == address(0), "exists");
        strategies[strategyId] = StrategyInfo(msg.sender, true, uint64(block.number));
        emit StrategyRegistered(msg.sender, strategyId, commitment);
    }

    /// @notice One-transaction onboarding: set the exposure cap and register the commitment.
    function registerStrategyWithLimit(bytes32 commitment, uint256 maxNotional) external returns (bytes32) {
        setRiskLimit(maxNotional);
        return registerStrategy(commitment);
    }

    function setStrategyActive(bytes32 strategyId, bool active) external {
        require(strategies[strategyId].firm == msg.sender, "not owner");
        strategies[strategyId].active = active;
        emit StrategyStatus(strategyId, active);
    }

    /// @notice Firm-controlled kill switch / exposure cap that the enclave cannot override.
    function setRiskLimit(uint256 maxNotional) public {
        maxNotionalPerBatch[msg.sender] = maxNotional;
        emit RiskLimitSet(msg.sender, maxNotional);
    }

    // ─────────────────────────────── settlement ───────────────────────────────
    function batchDigest(Batch calldata b) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), b));
    }

    function settle(Batch calldata b, bytes calldata signature) external {
        require(!batchUsed[b.batchId], "batch replay");
        batchUsed[b.batchId] = true;
        require(block.number <= b.validUntilBlock, "batch expired");

        address signer = _recover(batchDigest(b), signature);
        require(registry.isActive(signer), "unattested signer");

        (uint256 oraclePx, uint256 updatedBlock) = oracle.latest();
        require(block.number - updatedBlock <= MAX_ORACLE_AGE_BLOCKS, "stale oracle");
        require(_diffBps(b.price, oraclePx) <= ORACLE_BAND_BPS, "price outside oracle band");

        uint256 px = b.price;
        uint256 n = b.fills.length;
        Leg[] memory legs = new Leg[](n);

        // 1. validate + escrow
        uint256 totalBuy;
        uint256 totalSell;
        for (uint256 i; i < n; ++i) {
            Fill calldata f = b.fills[i];
            uint8 reason = _escrow(f, px, legs[i]);
            if (reason != 0) {
                emit FillRejected(b.batchId, f.strategyId, reason);
                continue;
            }
            if (f.isBuy) totalBuy += f.baseAmount;
            else totalSell += f.baseAmount;
        }

        // 2. cross internally at px (rounding always favors the pool → ledger stays solvent)
        uint256 crossed = totalBuy < totalSell ? totalBuy : totalSell;
        uint256 quotePaid;
        uint256 sellerCrossed;
        uint256 residualQuote;
        uint256 residualBase;
        for (uint256 i; i < n; ++i) {
            if (!legs[i].ok) continue;
            Fill calldata f = b.fills[i];
            Leg memory l = legs[i];
            if (f.isBuy) {
                l.crossedBase = f.baseAmount * crossed / totalBuy;
                l.quoteCrossed = _ceilDiv(l.crossedBase * px, 1e18);
                l.residualIn = (f.baseAmount - l.crossedBase) * px / 1e18;
                l.refund = _ceilDiv(f.baseAmount * px, 1e18) - l.quoteCrossed - l.residualIn;
                quotePaid += l.quoteCrossed;
                residualQuote += l.residualIn;
            } else {
                l.crossedBase = _ceilDiv(f.baseAmount * crossed, totalSell);
                l.residualIn = f.baseAmount - l.crossedBase;
                sellerCrossed += l.crossedBase;
                residualBase += l.residualIn;
            }
        }
        // sellers share exactly the quote buyers paid
        for (uint256 i; i < n; ++i) {
            if (legs[i].ok && !b.fills[i].isBuy && sellerCrossed > 0) {
                legs[i].quoteCrossed = quotePaid * legs[i].crossedBase / sellerCrossed;
            }
        }

        // 3. route the net residual to the public AMM with an oracle-derived floor
        bool routedIsBuy = residualQuote > 0;
        uint256 routedIn = routedIsBuy ? residualQuote : residualBase;
        uint256 routedOut;
        if (routedIn > 0) {
            uint256 fair = routedIsBuy ? routedIn * 1e18 / oraclePx : routedIn * oraclePx / 1e18;
            uint256 minOut = fair * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
            routedOut = amm.swapExactIn(routedIsBuy ? quote : base, routedIn, minOut, address(this));
            for (uint256 i; i < n; ++i) {
                if (legs[i].ok && legs[i].residualIn > 0) {
                    legs[i].routedOut = routedOut * legs[i].residualIn / routedIn;
                }
            }
        }

        // 4. credit + emit
        for (uint256 i; i < n; ++i) {
            Leg memory l = legs[i];
            if (!l.ok) continue;
            Fill calldata f = b.fills[i];
            if (f.isBuy) {
                balanceOf[l.firm][base] += l.crossedBase + l.routedOut;
                balanceOf[l.firm][quote] += l.refund;
                emit Filled(
                    b.batchId,
                    f.strategyId,
                    l.firm,
                    true,
                    l.crossedBase + l.routedOut,
                    l.quoteCrossed + l.residualIn,
                    l.crossedBase
                );
            } else {
                balanceOf[l.firm][quote] += l.quoteCrossed + l.routedOut;
                emit Filled(
                    b.batchId, f.strategyId, l.firm, false, f.baseAmount, l.quoteCrossed + l.routedOut, l.crossedBase
                );
            }
        }

        batchesSettled++;
        cumulativeCrossedBase += crossed;
        cumulativeRoutedBase += routedIsBuy ? routedOut : routedIn;
        emit BatchSettled(b.batchId, signer, px, crossed, routedIn, routedOut, routedIsBuy);
    }

    // ─────────────────────────────── internals ───────────────────────────────
    function _escrow(Fill calldata f, uint256 px, Leg memory l) internal returns (uint8) {
        StrategyInfo memory s = strategies[f.strategyId];
        if (s.firm == address(0) || !s.active) return REJECT_UNKNOWN_STRATEGY;
        if (f.baseAmount == 0) return REJECT_ZERO;
        uint256 notional = _ceilDiv(f.baseAmount * px, 1e18);
        if (notional > maxNotionalPerBatch[s.firm]) return REJECT_RISK_LIMIT;

        (address token, uint256 amount) = f.isBuy ? (quote, notional) : (base, f.baseAmount);
        if (balanceOf[s.firm][token] < amount) return REJECT_BALANCE;
        balanceOf[s.firm][token] -= amount;

        l.firm = s.firm;
        l.ok = true;
        return 0;
    }

    function _checkToken(address token) internal view {
        require(token == base || token == quote, "unsupported token");
    }

    function _diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return d * 10_000 / b;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Enclave signs the digest with an EIP-191 personal_sign prefix.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address signer = ecrecover(ethHash, v, r, s);
        require(signer != address(0), "bad sig");
        return signer;
    }
}
