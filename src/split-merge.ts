import { ethers } from "ethers";
import { getContractConfig, CONDITIONAL_TOKEN_DECIMALS } from "@polymarket/clob-client";
import { PRIVATE_KEY, CHAIN_ID, RPC_CONFIG } from "./config.js";
import type { MarketInfo } from "./types.js";

const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const TX_TIMEOUT_MS = 60000; // 60s timeout for transactions

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transaction mutex to prevent concurrent on-chain transactions (nonce conflicts)
let txMutexPromise: Promise<void> = Promise.resolve();

async function withTxMutex<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the existing mutex promise
  const currentPromise = txMutexPromise;
  let resolve: () => void;
  txMutexPromise = new Promise<void>((r) => { resolve = r; });
  
  // Wait for previous transaction to complete
  await currentPromise;
  
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    )
  ]);
}

const GAS_CACHE_TTL_MS = 10000; // Cache gas price for 10s
const GAS_MULTIPLIER = 1.15; // 15% buffer for faster inclusion
let cachedGasPrice: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null = null;
let gasCacheTime = 0;

async function getPolygonGasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const now = Date.now();
  if (cachedGasPrice && now - gasCacheTime < GAS_CACHE_TTL_MS) {
    return cachedGasPrice;
  }
  
  try {
    const response = await fetch("https://gasstation.polygon.technology/v2");
    const data = await response.json() as { fast: { maxFee: number; maxPriorityFee: number } };
    
    // Apply multiplier for faster inclusion
    const maxFee = Math.ceil(data.fast.maxFee * GAS_MULTIPLIER);
    const maxPriority = Math.ceil(data.fast.maxPriorityFee * GAS_MULTIPLIER);
    
    console.log(`[SplitMerge] Gas: ${maxFee} gwei (${GAS_MULTIPLIER}x fast)`);
    
    cachedGasPrice = {
      maxFeePerGas: ethers.parseUnits(maxFee.toString(), "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits(maxPriority.toString(), "gwei"),
    };
    gasCacheTime = now;
    return cachedGasPrice;
  } catch (err) {
    console.log(`[SplitMerge] Gas station failed, using fallback: 150 gwei`);
    return {
      maxFeePerGas: ethers.parseUnits("150", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("75", "gwei"),
    };
  }
}

function createProvider(): ethers.JsonRpcProvider {
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC, 137, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  
  // Use Polygon gas station for accurate gas pricing
  provider.getFeeData = async () => {
    const { maxFeePerGas, maxPriorityFeePerGas } = await getPolygonGasPrice();
    return new ethers.FeeData(null, maxFeePerGas, maxPriorityFeePerGas);
  };
  
  return provider;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries = RPC_CONFIG.maxRetries
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sleep(RPC_CONFIG.delayMs);
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const isRateLimit = lastError.message?.includes("RPS limit") || 
                          lastError.message?.includes("rate limit") ||
                          lastError.message?.includes("-32005");
      
      if (isRateLimit && attempt < maxRetries) {
        const delay = RPC_CONFIG.retryDelayMs * attempt;
        console.log(`[SplitMerge] ${operation} rate limited, retry ${attempt}/${maxRetries} in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

const NegRiskAdapterABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "splitPosition",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "mergePositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const ConditionalTokenABI = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    name: "splitPosition",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    name: "mergePositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

function getWallet(): ethers.Wallet {
  if (!wallet) {
    provider = createProvider();
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  }
  return wallet;
}

function getContracts(isNegRisk: boolean) {
  const w = getWallet();
  const contracts = getContractConfig(CHAIN_ID);
  
  const negRiskAdapter = new ethers.Contract(
    contracts.negRiskAdapter,
    NegRiskAdapterABI,
    w
  );
  
  const ctf = new ethers.Contract(
    contracts.conditionalTokens,
    ConditionalTokenABI,
    w
  );
  
  const usdc = new ethers.Contract(contracts.collateral, ERC20_ABI, w);
  
  return { negRiskAdapter, ctf, usdc, contracts };
}

export async function approveUSDCForSplit(amountUSD: number, isNegRisk: boolean): Promise<void> {
  const { usdc, contracts, negRiskAdapter, ctf } = getContracts(isNegRisk);
  const w = getWallet();
  
  const spender = isNegRisk ? await negRiskAdapter.getAddress() : await ctf.getAddress();
  const amount = ethers.parseUnits(amountUSD.toString(), CONDITIONAL_TOKEN_DECIMALS);
  
  const currentAllowance = await usdc.allowance(w.address, spender);
  
  if (currentAllowance < amount) {
    console.log(`[SplitMerge] Approving USDC for ${isNegRisk ? "NegRisk" : "CTF"}...`);
    const tx = await usdc.approve(spender, ethers.MaxUint256);
    await tx.wait();
    console.log(`[SplitMerge] USDC approved`);
  }
}

function truncateToDecimals(value: number, decimals: number): string {
  const multiplier = Math.pow(10, decimals);
  const truncated = Math.floor(value * multiplier) / multiplier;
  return truncated.toFixed(decimals);
}

export async function splitPosition(
  market: MarketInfo,
  amountUSD: number
): Promise<{ upTokens: number; downTokens: number }> {
  // Use mutex to prevent concurrent transactions (nonce conflicts)
  return withTxMutex(async () => {
    const { negRiskAdapter, ctf, contracts } = getContracts(market.negRisk);
    
    const truncatedAmount = truncateToDecimals(amountUSD, CONDITIONAL_TOKEN_DECIMALS);
    const amount = ethers.parseUnits(truncatedAmount, CONDITIONAL_TOKEN_DECIMALS);
    
    console.log(`[SplitMerge] Splitting $${truncatedAmount} into UP/DOWN tokens...`);
    console.log(`[SplitMerge] Using RPC: ${POLYGON_RPC}`);
    console.log(`[SplitMerge] NegRisk: ${market.negRisk}, ConditionId: ${market.conditionId.slice(0, 20)}...`);
    
    // Get balance before split
    console.log(`[SplitMerge] Checking balance before...`);
    const balanceBefore = await withTimeout(
      withRetry(() => getTokenBalance(market.upTokenId), "getBalanceBefore"),
      30000,
      "getBalanceBefore"
    );
    console.log(`[SplitMerge] Balance before: ${balanceBefore}`);
    
    console.log(`[SplitMerge] Approving USDC...`);
    await withTimeout(
      approveUSDCForSplit(parseFloat(truncatedAmount), market.negRisk),
      TX_TIMEOUT_MS,
      "approveUSDC"
    );
    
    // Execute split with retry and timeout
    console.log(`[SplitMerge] Submitting split transaction...`);
    const tx = await withTimeout(
      withRetry(async () => {
        if (market.negRisk) {
          return await negRiskAdapter.splitPosition(market.conditionId, amount);
        } else {
          return await ctf.splitPosition(
            contracts.collateral,
            ethers.ZeroHash,
            market.conditionId,
            [1, 2],
            amount
          );
        }
      }, "splitPosition"),
      TX_TIMEOUT_MS,
      "splitPosition"
    );
    
    console.log(`[SplitMerge] Tx submitted: ${tx.hash}, waiting for confirmation...`);
    const receipt = await withTimeout(tx.wait() as Promise<ethers.TransactionReceipt>, TX_TIMEOUT_MS, "txWait");
    console.log(`[SplitMerge] Tx confirmed: ${receipt.hash}`);
    
    // Verify balance changed
    await sleep(RPC_CONFIG.delayMs * 2);
    console.log(`[SplitMerge] Verifying balance after...`);
    const balanceAfter = await withTimeout(
      withRetry(() => getTokenBalance(market.upTokenId), "getBalanceAfter"),
      30000,
      "getBalanceAfter"
    );
    
    const tokensReceived = balanceAfter - balanceBefore;
    if (tokensReceived <= 0) {
      throw new Error(`Split verification failed: balance unchanged (before=${balanceBefore}, after=${balanceAfter})`);
    }
    
    console.log(`[SplitMerge] Split verified: received ${tokensReceived.toFixed(2)} tokens`);
    
    return {
      upTokens: tokensReceived,
      downTokens: tokensReceived,
    };
  });
}

export async function mergePositions(
  market: MarketInfo,
  amountTokens: number
): Promise<number> {
  // Use mutex to prevent concurrent transactions (nonce conflicts)
  return withTxMutex(async () => {
    const { negRiskAdapter, ctf, contracts } = getContracts(market.negRisk);
    const amount = ethers.parseUnits(amountTokens.toString(), CONDITIONAL_TOKEN_DECIMALS);
    
    console.log(`[SplitMerge] Merging ${amountTokens} UP/DOWN tokens back to USDC...`);
    
    let tx;
    if (market.negRisk) {
      tx = await negRiskAdapter.mergePositions(market.conditionId, amount);
    } else {
      tx = await ctf.mergePositions(
        contracts.collateral,
        ethers.ZeroHash,
        market.conditionId,
        [1, 2],
        amount
      );
    }
    
    const receipt = await tx.wait();
    console.log(`[SplitMerge] Merge complete. Tx: ${receipt.hash}`);
    
    return amountTokens;
  });
}

export async function getTokenBalance(tokenId: string): Promise<number> {
  const w = getWallet();
  const contracts = getContractConfig(CHAIN_ID);
  
  const ctf = new ethers.Contract(
    contracts.conditionalTokens,
    ["function balanceOf(address owner, uint256 id) view returns (uint256)"],
    w
  );
  
  const balance = await ctf.balanceOf(w.address, tokenId);
  return Number(ethers.formatUnits(balance, CONDITIONAL_TOKEN_DECIMALS));
}
