pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ReFiInfraDAOFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => euint32) public totalContributionsEncrypted;
    mapping(uint256 => euint32) public totalUsageEncrypted;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ContributionSubmitted(address indexed contributor, uint256 indexed batchId, uint256 encryptedAmount);
    event UsageReported(address indexed provider, uint256 indexed batchId, uint256 encryptedUsage);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalContributions, uint256 totalUsage);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchNotOpen();
    error ReplayDetected();
    error StateMismatch();
    error InvalidBatchId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1;
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) public onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        if (!paused) revert PausedError(); // Cannot unpause if not paused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() public onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        totalContributionsEncrypted[currentBatchId] = FHE.asEuint32(0);
        totalUsageEncrypted[currentBatchId] = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) public onlyOwner whenNotPaused {
        if (!isBatchOpen[batchId]) revert BatchNotOpen();
        isBatchOpen[batchId] = false;
        emit BatchClosed(batchId);
    }

    function submitContribution(uint256 batchId, euint32 encryptedAmount) public whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!isBatchOpen[batchId]) revert BatchNotOpen();

        _initIfNeeded(totalContributionsEncrypted[batchId]);
        totalContributionsEncrypted[batchId] = totalContributionsEncrypted[batchId].add(encryptedAmount);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ContributionSubmitted(msg.sender, batchId, encryptedAmount.toBytes32());
    }

    function reportUsage(uint256 batchId, euint32 encryptedUsage) public onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) { // Providers also subject to submission cooldown
            revert CooldownActive();
        }
        if (!isBatchOpen[batchId]) revert BatchNotOpen();

        _initIfNeeded(totalUsageEncrypted[batchId]);
        totalUsageEncrypted[batchId] = totalUsageEncrypted[batchId].add(encryptedUsage);

        lastSubmissionTime[msg.sender] = block.timestamp; // Update provider's last submission time
        emit UsageReported(msg.sender, batchId, encryptedUsage.toBytes32());
    }

    function requestBatchSummaryDecryption(uint256 batchId) public whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (isBatchOpen[batchId]) revert BatchNotOpen(); // Batch must be closed for summary

        euint32 contributions = totalContributionsEncrypted[batchId];
        euint32 usage = totalUsageEncrypted[batchId];
        if (!FHE.isInitialized(contributions) || !FHE.isInitialized(usage)) {
            revert InvalidBatchId(); // Or a more specific error
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = contributions.toBytes32();
        cts[1] = usage.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayDetected();
        }
        // Security: Replay protection ensures this callback is processed only once for a given requestId.

        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 contributions = totalContributionsEncrypted[batchId];
        euint32 usage = totalUsageEncrypted[batchId];

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = contributions.toBytes32();
        cts[1] = usage.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State verification ensures that the ciphertexts that were originally requested for decryption
        // have not changed in contract storage before the callback is processed.
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalContributions = abi.decode(cleartexts[0:32], uint256);
        uint256 totalUsage = abi.decode(cleartexts[32:64], uint256);

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalContributions, totalUsage);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage x) internal {
        if (!FHE.isInitialized(x)) {
            x = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 x) internal pure {
        if (!FHE.isInitialized(x)) revert("FHEVarNotInitialized");
    }
}