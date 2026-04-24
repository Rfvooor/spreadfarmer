import { ethers } from "ethers";
import { FUNDER_ADDRESS, RPC_CONFIG } from "./config.js";

const DATA_API_HOST = "https://data-api.polymarket.com";
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export interface WalletBalance {
  usdcBalance: number;
  holdingsValue: number;
  totalEquity: number;
}

export interface PositionInfo {
  assetId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface TradeInfo {
  id: string;
  assetId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: Date;
}

export async function getUSDCBalance(walletAddress?: string): Promise<number> {
  const address = walletAddress || FUNDER_ADDRESS;
  if (!address) {
    throw new Error("No wallet address provided");
  }

  await sleep(RPC_CONFIG.delayMs);
  
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  const balance = await usdc.balanceOf(address);
  const decimals = await usdc.decimals();

  return Number(balance) / Math.pow(10, Number(decimals));
}

export async function getHoldingsValue(walletAddress?: string): Promise<number> {
  const address = walletAddress || FUNDER_ADDRESS;
  if (!address) {
    throw new Error("No wallet address provided");
  }

  const url = `${DATA_API_HOST}/value?user=${address.toLowerCase()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Wallet] Failed to get holdings value: ${response.statusText}`);
      return 0;
    }

    const data = (await response.json()) as Array<{ user: string; value: number }>;
    if (data.length > 0 && data[0].value) {
      return data[0].value;
    }
  } catch (err) {
    console.error("[Wallet] Error fetching holdings value:", err);
  }

  return 0;
}

export async function getWalletBalance(walletAddress?: string): Promise<WalletBalance> {
  const address = walletAddress || FUNDER_ADDRESS;

  const [usdcBalance, holdingsValue] = await Promise.all([
    getUSDCBalance(address),
    getHoldingsValue(address),
  ]);

  return {
    usdcBalance,
    holdingsValue,
    totalEquity: usdcBalance + holdingsValue,
  };
}

export async function getPositions(walletAddress?: string): Promise<PositionInfo[]> {
  const address = walletAddress || FUNDER_ADDRESS;
  if (!address) {
    throw new Error("No wallet address provided");
  }

  const url = `${DATA_API_HOST}/positions?user=${address.toLowerCase()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Wallet] Failed to get positions: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as Array<{
      asset: string;
      conditionId: string;
      outcome: string;
      size: string;
      avgPrice: string;
      curPrice: string;
      realizedPnl?: string;
      unrealizedPnl?: string;
    }>;

    return data
      .filter((pos) => {
        const currentPrice = parseFloat(pos.curPrice) || 0;
        // Filter out settled positions (price = 0 or 1)
        return currentPrice > 0.001 && currentPrice < 0.999;
      })
      .map((pos) => {
        const size = parseFloat(pos.size) || 0;
        const avgPrice = parseFloat(pos.avgPrice) || 0;
        const currentPrice = parseFloat(pos.curPrice) || 0;
        const cost = size * avgPrice;
        const value = size * currentPrice;
        const pnl = value - cost;
        const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

        return {
          assetId: pos.asset,
          conditionId: pos.conditionId,
          outcome: pos.outcome,
          size,
          avgPrice,
          currentPrice,
          pnl,
          pnlPercent,
        };
      });
  } catch (err) {
    console.error("[Wallet] Error fetching positions:", err);
    return [];
  }
}

export async function getPositionsForMarket(upTokenId: string, downTokenId: string): Promise<{ upShares: number; downShares: number }> {
  const positions = await getPositions();
  
  let upShares = 0;
  let downShares = 0;
  
  for (const pos of positions) {
    if (pos.assetId === upTokenId) {
      upShares = pos.size;
    } else if (pos.assetId === downTokenId) {
      downShares = pos.size;
    }
  }
  
  return { upShares, downShares };
}

/**
 * Fetch recent trades for a wallet from the data API.
 * Use to get actual fill prices instead of estimating.
 */
export async function getRecentTrades(limit: number = 10, walletAddress?: string): Promise<TradeInfo[]> {
  const address = walletAddress || FUNDER_ADDRESS;
  if (!address) {
    throw new Error("No wallet address provided");
  }

  const url = `${DATA_API_HOST}/trades?limit=${limit}&user=${address.toLowerCase()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Wallet] Failed to get trades: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as Array<{
      asset: string;
      side: string;
      size: number;
      price: number;
      timestamp: number;
      transactionHash: string;
    }>;

    return data.map((trade) => ({
      id: trade.transactionHash,
      assetId: trade.asset,
      side: trade.side === "BUY" ? "BUY" : "SELL",
      size: trade.size,
      price: trade.price,
      timestamp: new Date(trade.timestamp * 1000),
    }));
  } catch (err) {
    console.error("[Wallet] Error fetching trades:", err);
    return [];
  }
}

/**
 * Get recent trades for specific market tokens.
 * Returns trades filtered to only UP/DOWN tokens, sorted newest first.
 */
export async function getTradesForMarket(
  upTokenId: string,
  downTokenId: string,
  limit: number = 10
): Promise<{ upTrades: TradeInfo[]; downTrades: TradeInfo[] }> {
  const allTrades = await getRecentTrades(limit);
  
  const upTrades: TradeInfo[] = [];
  const downTrades: TradeInfo[] = [];
  
  for (const trade of allTrades) {
    if (trade.assetId === upTokenId) {
      upTrades.push(trade);
    } else if (trade.assetId === downTokenId) {
      downTrades.push(trade);
    }
  }
  
  return { upTrades, downTrades };
}

export async function logWalletStatus(): Promise<void> {
  const balance = await getWalletBalance();
  console.log("\n" + "=".repeat(50));
  console.log("💰 WALLET STATUS");
  console.log("=".repeat(50));
  console.log(`  USDC Balance:    $${balance.usdcBalance.toFixed(2)}`);
  console.log(`  Holdings Value:  $${balance.holdingsValue.toFixed(2)}`);
  console.log(`  Total Equity:    $${balance.totalEquity.toFixed(2)}`);
  console.log("=".repeat(50));

  const positions = await getPositions();
  if (positions.length > 0) {
    console.log(`\n📊 OPEN POSITIONS (${positions.length})`);
    console.log("-".repeat(50));
    for (const pos of positions) {
      const pnlColor = pos.pnl >= 0 ? "+" : "";
      console.log(
        `  ${pos.outcome.padEnd(10)} | Size: ${pos.size.toFixed(2).padStart(8)} | ` +
          `Price: ${pos.currentPrice.toFixed(3)} | PnL: ${pnlColor}$${pos.pnl.toFixed(2)} (${pnlColor}${pos.pnlPercent.toFixed(1)}%)`
      );
    }
    console.log("-".repeat(50));
  }
}
