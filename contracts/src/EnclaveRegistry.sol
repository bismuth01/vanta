// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnclaveRegistry
/// @notice On-chain root of trust for the Sealed Strategy Engine.
///         An enclave is accepted only if its attestation quote proves it runs the
///         expected code measurement and binds (signer, encryptionKey) to that code.
///         Firms read `encryptionKey` from here and encrypt their strategies to it,
///         so they never have to trust the operator, only the attested code.
///
/// @dev HACKATHON MOCK: the "quote" is abi.encode(measurement, reportData).
///      In production, verify an Intel TDX DCAP quote with Automata's on-chain
///      verifier and read measurement (MRTD/RTMR) + reportData from the verified quote.
contract EnclaveRegistry {
    struct Enclave {
        bytes32 measurement;
        bytes32 encryptionKey; // x25519 public key
        uint64 registeredAt;
        bool active;
    }

    address public immutable owner;
    bytes32 public expectedMeasurement;
    mapping(address signer => Enclave) public enclaves;
    address[] public signers;

    event MeasurementApproved(bytes32 measurement);
    event EnclaveRegistered(address indexed signer, bytes32 measurement, bytes32 encryptionKey);
    event EnclaveRevoked(address indexed signer);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Governance approves a specific enclave build (reproducible-build hash).
    function approveMeasurement(bytes32 measurement) external onlyOwner {
        expectedMeasurement = measurement;
        emit MeasurementApproved(measurement);
    }

    /// @notice Permissionless: anyone can register an enclave that presents a valid quote.
    function registerEnclave(address signer, bytes32 encryptionKey, bytes calldata quote) external {
        (bytes32 measurement, bytes32 reportData) = abi.decode(quote, (bytes32, bytes32));
        require(measurement == expectedMeasurement, "unapproved measurement");
        require(reportData == keccak256(abi.encode(signer, encryptionKey)), "report data mismatch");

        if (enclaves[signer].registeredAt == 0) signers.push(signer);
        enclaves[signer] = Enclave(measurement, encryptionKey, uint64(block.number), true);
        emit EnclaveRegistered(signer, measurement, encryptionKey);
    }

    function revoke(address signer) external onlyOwner {
        enclaves[signer].active = false;
        emit EnclaveRevoked(signer);
    }

    function isActive(address signer) external view returns (bool) {
        Enclave storage e = enclaves[signer];
        return e.active && e.measurement == expectedMeasurement;
    }

    function latestSigner() external view returns (address) {
        return signers.length == 0 ? address(0) : signers[signers.length - 1];
    }
}
