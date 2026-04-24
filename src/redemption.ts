import { ethers } from "ethers";
import { PRIVATE_KEY, RPC_CONFIG } from "./config.js";

const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_COLLATERAL = ethers.ZeroHash;

const CTF_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function redeemPositions(address collateral, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
];

const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

interface PolymarketPosition {
  outcome: string;
  curPrice: number;
  conditionId: string;
  outcomeIndex: number;
  asset: string;
  title: string;
  size: number;
}

const processedConditions = new Set<string>();

function createProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(POLYGON_RPC, 137, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

async function fetchRedeemablePositions(walletAddress: string): Promise<PolymarketPosition[]> {
  try {
    const url = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    
    if (!response.ok) {
      console.log(`[Redemption] Failed to fetch positions: ${response.status}`);
      return [];
    }
    
    const data = await response.json() as { data?: PolymarketPosition[] } | PolymarketPosition[];
    const positions: PolymarketPosition[] = Array.isArray(data) ? data : (data.data || []);
    return positions;
  } catch (err) {
    console.error("[Redemption] Error fetching positions:", err);
    return [];
  }
}

async function checkMarketResolved(ctf: ethers.Contract, conditionId: string): Promise<boolean> {
  try {
    const conditionBytes = conditionId.startsWith("0x") ? conditionId : `0x${conditionId}`;
    const slots = await ctf.getOutcomeSlotCount(conditionBytes);
    
    let totalPayout = 0n;
    for (let i = 0; i < Number(slots); i++) {
      const payout = await ctf.payoutNumerators(conditionBytes, i);
      totalPayout += payout;
    }
    
    return totalPayout > 0n;
  } catch (err) {
    return false;
  }
}

async function redeemPosition(
  ctf: ethers.Contract,
  wallet: ethers.Wallet,
  conditionId: string,
  outcomeIndex: number
): Promise<boolean> {
  try {
    const conditionBytes = conditionId.startsWith("0x") ? conditionId : `0x${conditionId}`;
    const indexSet = 1 << outcomeIndex;
    
    const tx = await ctf.redeemPositions(
      USDC_ADDRESS,
      ZERO_COLLATERAL,
      conditionBytes,
      [indexSet]
    );
    
    console.log(`[Redemption] Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log(`[Redemption] ✅ Redeemed successfully`);
      return true;
    } else {
      console.log(`[Redemption] ❌ Transaction failed`);
      return false;
    }
  } catch (err) {
    console.error(`[Redemption] Error:`, err);
    return false;
  }
}

export async function runRedemptionCheck(): Promise<{ redeemed: number; usdcGained: number }> {
  console.log(`[Redemption] Checking for redeemable positions...`);
  
  const provider = createProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  
  const balanceBefore = await usdc.balanceOf(wallet.address);
  console.log(`[Redemption] USDC before: $${Number(ethers.formatUnits(balanceBefore, 6)).toFixed(2)}`);
  
  const positions = await fetchRedeemablePositions(wallet.address);
  if (positions.length === 0) {
    console.log(`[Redemption] No positions found`);
    return { redeemed: 0, usdcGained: 0 };
  }
  
  console.log(`[Redemption] Found ${positions.length} positions to check`);
  
  let totalRedeemed = 0;
  
  for (const pos of positions) {
    if (!pos.outcome) continue;
    if (Math.round(pos.curPrice * 100) === 0) continue;
    
    const condId = pos.conditionId.startsWith("0x") 
      ? pos.conditionId.slice(2) 
      : pos.conditionId;
    
    // Skip if already processed
    if (processedConditions.has(condId)) continue;
    
    // Check token balance
    const tokenId = BigInt(pos.asset);
    const tokenBalance = await ctf.balanceOf(wallet.address, tokenId);
    if (tokenBalance === 0n) continue;
    
    // Check if market is resolved
    const isResolved = await checkMarketResolved(ctf, pos.conditionId);
    if (!isResolved) continue;
    
    const title = (pos.title || "Unknown").slice(0, 40);
    console.log(`[Redemption] Redeeming: ${title} (${Number(ethers.formatUnits(tokenBalance, 6)).toFixed(2)} tokens)`);
    
    const success = await redeemPosition(ctf, wallet, pos.conditionId, pos.outcomeIndex || 0);
    if (success) {
      totalRedeemed++;
      processedConditions.add(condId);
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, RPC_CONFIG.delayMs));
  }
  
  const balanceAfter = await usdc.balanceOf(wallet.address);
  const gained = Number(ethers.formatUnits(balanceAfter - balanceBefore, 6));
  
  console.log(`[Redemption] Redeemed: ${totalRedeemed} positions, USDC gained: $${gained.toFixed(2)}`);
  
  return { redeemed: totalRedeemed, usdcGained: gained };
}

// Track last redemption check time per window
let lastRedemptionWindow = 0;

export function shouldRunRedemption(windowEndTime: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const timeSinceEnd = now - windowEndTime;
  
  // Run 60s after window ends, but only once per window
  if (timeSinceEnd >= 60 && timeSinceEnd < 120 && windowEndTime !== lastRedemptionWindow) {
    lastRedemptionWindow = windowEndTime;
    return true;
  }
  
  return false;
}
