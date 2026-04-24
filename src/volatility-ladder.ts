/**
 * Polymarket 15-Minute Volatility Ladder (Merge Arbitrage)
 * 
 * Strategy: Accumulate complementary UP/DOWN positions at combined cost < $1.00
 * enabling risk-free merge profit regardless of outcome.
 * 
 * Core Invariant: PAIR_COST = avg_cost_up + avg_cost_down < 0.96
 */

import { OrderType, Side } from "@polymarket/clob-client";
import { getClient, initClient } from "./client.js";
import { BOT_CONFIG, CLOB_HOST } from "./config.js";
import { fetchCryptoMarkets, getTimeToSettlement, hasWindowChanged, getCurrentWindowStart, formatWindowTime, type MarketType } from "./markets.js";
import { roundToTick } from "./pricing.js";
import { cancelOrdersForMarket, getOrder } from "./orders.js";
import { mergePositions } from "./split-merge.js";
import type { MarketInfo, OrderInfo } from "./types.js";
import { getWalletBalance, getPositionsForMarket, getRecentTrades } from "./wallet.js";
import { wsManager } from "./websocket.js";

// ============================================================================
// CONFIGURATION (PRD §7)
// ============================================================================

interface VolatilityLadderConfig {
  // Entry
  seedSizePct: number;           // 25% of max position for seed
  seedPriceOffsetTicks: number;  // +1 tick from mid for entry
  seedTimeoutSec: number;        // 60s timeout for seed fill
  minViablePosition: number;     // Minimum shares to proceed (accept partial fill)
  
  // Accumulation (Bidmap)
  mergeThreshold: number;        // PAIR_COST target: $0.96
  favorableMoves: BidmapLevel[]; // When opposite side gets cheaper
  unfavorableMoves: BidmapLevel[]; // When same side gets cheaper (averaging down)
  
  // Exit
  timeStopSec: number;           // 120s before resolution
  forceExitSec: number;          // 60s emergency exit
  
  // Risk
  maxPositionSize: number;       // 1.0 unit per side
  maxTotalSpend: number;         // $1.05 max spend
  maxLossPerTrade: number;       // $0.10 max loss
  maxConcurrentMarkets: number;  // 3 markets at once
  
  // Market Quality Filters
  maxEntrySpread: number;        // Skip if spread > 0.10
  minVolume: number;             // Skip if volume too low
  maxDirectionalBias: number;    // Skip if |mid - 0.50| > 0.15
  minOrderBookDepth: number;     // Min size on best bid/ask
  
  // Order Management
  orderTimeoutSec: number;       // Cancel stale orders after 30s
  repositionThreshold: number;   // Reposition if price moves 2 ticks
  minPairCostImprovement: number; // Only accumulate if improves by 0.01
  
  // Polling
  pollIntervalMs: number;
  marketType: MarketType;
}

interface BidmapLevel {
  priceDelta: number;  // Price movement threshold (e.g., +0.03)
  sizePct: number;     // Position size as % of max (e.g., 0.20)
}

const CONFIG: VolatilityLadderConfig = {
  // Entry
  seedSizePct: parseFloat(process.env.VL_SEED_SIZE_PCT || "0.25"),
  seedPriceOffsetTicks: parseInt(process.env.VL_SEED_OFFSET_TICKS || "1"),
  seedTimeoutSec: parseFloat(process.env.VL_SEED_TIMEOUT_SEC || "60"),
  minViablePosition: parseFloat(process.env.VL_MIN_VIABLE_POSITION || "10"),
  
  // Merge threshold
  mergeThreshold: parseFloat(process.env.VL_MERGE_THRESHOLD || "0.96"),
  
  // Bidmap - Favorable moves (opposite side getting cheaper)
  favorableMoves: [
    { priceDelta: 0.03, sizePct: 0.20 },
    { priceDelta: 0.05, sizePct: 0.25 },
    { priceDelta: 0.08, sizePct: 0.30 },
    { priceDelta: 0.12, sizePct: 0.35 },
  ],
  
  // Bidmap - Unfavorable moves (same side getting cheaper - average down)
  unfavorableMoves: [
    { priceDelta: 0.03, sizePct: 0.15 },
    { priceDelta: 0.05, sizePct: 0.20 },
    { priceDelta: 0.08, sizePct: 0.15 },
  ],
  
  // Exit
  timeStopSec: parseFloat(process.env.VL_TIME_STOP_SEC || "120"),
  forceExitSec: parseFloat(process.env.VL_FORCE_EXIT_SEC || "60"),
  
  // Risk
  maxPositionSize: parseFloat(process.env.VL_MAX_POSITION_SIZE || "100"),
  maxTotalSpend: parseFloat(process.env.VL_MAX_TOTAL_SPEND || "105"),
  maxLossPerTrade: parseFloat(process.env.VL_MAX_LOSS_PER_TRADE || "10"),
  maxConcurrentMarkets: parseInt(process.env.VL_MAX_CONCURRENT_MARKETS || "3"),
  
  // Market Quality
  maxEntrySpread: parseFloat(process.env.VL_MAX_ENTRY_SPREAD || "0.10"),
  minVolume: parseFloat(process.env.VL_MIN_VOLUME || "50"),
  maxDirectionalBias: parseFloat(process.env.VL_MAX_DIRECTIONAL_BIAS || "0.15"),
  minOrderBookDepth: parseFloat(process.env.VL_MIN_ORDER_BOOK_DEPTH || "20"),
  
  // Order Management
  orderTimeoutSec: parseFloat(process.env.VL_ORDER_TIMEOUT_SEC || "30"),
  repositionThreshold: parseFloat(process.env.VL_REPOSITION_THRESHOLD || "0.02"),
  minPairCostImprovement: parseFloat(process.env.VL_MIN_PAIR_COST_IMPROVEMENT || "0.01"),
  
  // Polling
  pollIntervalMs: parseInt(process.env.VL_POLL_INTERVAL_MS || "1000"),
  marketType: (process.env.VL_MARKET_TYPE || "15m") as MarketType,
};

// ============================================================================
// STATE MACHINE (PRD §5)
// ============================================================================

enum LadderState {
  MARKET_DISCOVERY = "MARKET_DISCOVERY",
  INVENTORY_SEED = "INVENTORY_SEED",
  DYNAMIC_ACCUMULATION = "DYNAMIC_ACCUMULATION",
  INVENTORY_MANAGEMENT = "INVENTORY_MANAGEMENT",
  EXIT_MERGE = "EXIT_MERGE",
  EXIT_PANIC_CAPTURE = "EXIT_PANIC_CAPTURE",
  EXIT_TIME_STOP = "EXIT_TIME_STOP",
  EXIT_RISK_STOP = "EXIT_RISK_STOP",
  CLOSED = "CLOSED",
}

enum VolatilityRegime {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

interface PositionState {
  // Inventory
  qtyUp: number;
  qtyDown: number;
  avgCostUp: number;
  avgCostDown: number;
  
  // Key metrics (PRD §3 - Inventory Management)
  pairCost: number;              // avgCostUp + avgCostDown
  inventoryImbalance: number;    // abs(qtyUp - qtyDown)
  totalSpend: number;            // Total USDC spent
  
  // Risk
  maxLoss: number;               // Worst case if forced to flatten
  mergeProfit: number;           // If merged now: 1.00 - pairCost
}

interface ActiveOrder {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  placedAt: number;              // Timestamp
  targetSide: "UP" | "DOWN";     // Which side this order is for
}

interface LadderPosition {
  market: MarketInfo;
  state: LadderState;
  
  // Seed entry tracking
  seedSide: "UP" | "DOWN" | null;
  seedOrderId: string | null;
  seedPlacedAt: number | null;
  seedEntryPrice: number;
  
  // Position state
  position: PositionState;
  
  // Active orders
  activeOrders: Map<string, ActiveOrder>;
  
  // Bidmap execution tracking
  triggeredLevels: Set<string>;  // Track which bidmap levels have been triggered
  lastBidmapCheck: number;
  
  // Price tracking
  seedMidPrice: number;          // Mid price at seed time
  lastUpMid: number;
  lastDownMid: number;
  priceHistory: Array<{ timestamp: number; upMid: number; downMid: number }>;
  
  // Timing
  entryTime: Date;
  
  // PnL
  realizedPnL: number;
  exitReason: string | null;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

const activePositions: Map<string, LadderPosition> = new Map();
let isRunning = false;
let totalPnL = 0;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// PRICING & ORDERBOOK (PRD §3)
// ============================================================================

interface SpreadPricing {
  upBid: number;
  upAsk: number;
  upMid: number;
  downBid: number;
  downAsk: number;
  downMid: number;
  bidSum: number;
  askSum: number;
  spread: number;
  upSpread: number;
  downSpread: number;
  fromWebsocket: boolean;
}

function getSpreadPricingFromWS(market: MarketInfo): SpreadPricing | null {
  const upBid = wsManager.getBestBid(market.upTokenId);
  const upAsk = wsManager.getBestAsk(market.upTokenId);
  const downBid = wsManager.getBestBid(market.downTokenId);
  const downAsk = wsManager.getBestAsk(market.downTokenId);
  
  if (upBid === 0 && upAsk === 1 && downBid === 0 && downAsk === 1) {
    return null;
  }
  
  const upMid = (upBid + upAsk) / 2;
  const downMid = (downBid + downAsk) / 2;
  const bidSum = upBid + downBid;
  const askSum = upAsk + downAsk;
  
  return {
    upBid,
    upAsk,
    upMid,
    downBid,
    downAsk,
    downMid,
    bidSum,
    askSum,
    spread: askSum - bidSum,
    upSpread: upAsk - upBid,
    downSpread: downAsk - downBid,
    fromWebsocket: true,
  };
}

async function getSpreadPricingFromREST(market: MarketInfo): Promise<SpreadPricing> {
  const client = getClient();
  
  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(market.upTokenId),
    client.getOrderBook(market.downTokenId),
  ]);
  
  const upBid = upBook.bids.length > 0 ? parseFloat(upBook.bids[0].price) : 0;
  const upAsk = upBook.asks.length > 0 ? parseFloat(upBook.asks[0].price) : 1;
  const downBid = downBook.bids.length > 0 ? parseFloat(downBook.bids[0].price) : 0;
  const downAsk = downBook.asks.length > 0 ? parseFloat(downBook.asks[0].price) : 1;
  
  const upMid = (upBid + upAsk) / 2;
  const downMid = (downBid + downAsk) / 2;
  const bidSum = upBid + downBid;
  const askSum = upAsk + downAsk;
  
  return {
    upBid,
    upAsk,
    upMid,
    downBid,
    downAsk,
    downMid,
    bidSum,
    askSum,
    spread: askSum - bidSum,
    upSpread: upAsk - upBid,
    downSpread: downAsk - downBid,
    fromWebsocket: false,
  };
}

async function getSpreadPricing(market: MarketInfo): Promise<SpreadPricing> {
  const wsData = getSpreadPricingFromWS(market);
  if (wsData) return wsData;
  return getSpreadPricingFromREST(market);
}

function getOrderBookDepth(market: MarketInfo): { upBidSize: number; upAskSize: number; downBidSize: number; downAskSize: number } {
  const upBook = wsManager.getBook(market.upTokenId);
  const downBook = wsManager.getBook(market.downTokenId);
  
  let upBidSize = 0, upAskSize = 0, downBidSize = 0, downAskSize = 0;
  
  if (upBook) {
    if (upBook.bids.length > 0) upBidSize = parseFloat(upBook.bids[0].size);
    if (upBook.asks.length > 0) upAskSize = parseFloat(upBook.asks[0].size);
  }
  if (downBook) {
    if (downBook.bids.length > 0) downBidSize = parseFloat(downBook.bids[0].size);
    if (downBook.asks.length > 0) downAskSize = parseFloat(downBook.asks[0].size);
  }
  
  return { upBidSize, upAskSize, downBidSize, downAskSize };
}

// ============================================================================
// VOLATILITY REGIME DETECTION (PRD §5.2 - Dynamic Bidmap)
// ============================================================================

function calculateVolatilityRegime(pos: LadderPosition): VolatilityRegime {
  const history = pos.priceHistory;
  if (history.length < 10) return VolatilityRegime.MEDIUM;
  
  // Calculate recent price volatility (last 2 minutes)
  const lookback = 120000; // 2 minutes in ms
  const now = Date.now();
  const recentPrices = history.filter(h => now - h.timestamp < lookback);
  
  if (recentPrices.length < 5) return VolatilityRegime.MEDIUM;
  
  const upPrices = recentPrices.map(p => p.upMid);
  const stdDev = calculateStdDev(upPrices);
  
  if (stdDev > 0.08) return VolatilityRegime.HIGH;
  if (stdDev < 0.04) return VolatilityRegime.LOW;
  return VolatilityRegime.MEDIUM;
}

function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// ============================================================================
// DYNAMIC BIDMAP (PRD §5.2)
// ============================================================================

interface DynamicBidmap {
  favorableDeltas: number[];
  favorableSizes: number[];
  unfavorableDeltas: number[];
  unfavorableSizes: number[];
  orderTimeout: number;
  urgency: "LOW" | "NORMAL" | "URGENT" | "AGGRESSIVE";
}

function getDynamicBidmap(pos: LadderPosition, timeRemaining: number, pricing: SpreadPricing): DynamicBidmap {
  const volatilityRegime = calculateVolatilityRegime(pos);
  const avgSpread = (pricing.upSpread + pricing.downSpread) / 2;
  const pairCostDistance = pos.position.pairCost - CONFIG.mergeThreshold;
  
  // Start with base bidmap
  let favorableDeltas = CONFIG.favorableMoves.map(m => m.priceDelta);
  let favorableSizes = CONFIG.favorableMoves.map(m => m.sizePct);
  let unfavorableDeltas = CONFIG.unfavorableMoves.map(m => m.priceDelta);
  let unfavorableSizes = CONFIG.unfavorableMoves.map(m => m.sizePct);
  let orderTimeout = CONFIG.orderTimeoutSec;
  let urgency: "LOW" | "NORMAL" | "URGENT" | "AGGRESSIVE" = "NORMAL";
  
  // 1. Volatility adjustment
  if (volatilityRegime === VolatilityRegime.HIGH) {
    favorableDeltas = favorableDeltas.map(d => d * 1.5);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 1.5);
    favorableSizes = favorableSizes.map(s => s * 0.8);
    unfavorableSizes = unfavorableSizes.map(s => s * 0.8);
  } else if (volatilityRegime === VolatilityRegime.LOW) {
    favorableDeltas = favorableDeltas.map(d => d * 0.7);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 0.7);
    favorableSizes = favorableSizes.map(s => s * 1.2);
    unfavorableSizes = unfavorableSizes.map(s => s * 1.2);
  }
  
  // 2. Spread width adjustment
  if (avgSpread > 0.05) {
    favorableDeltas = favorableDeltas.map(d => d * 1.3);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 1.3);
    favorableSizes = favorableSizes.map(s => s * 0.7);
    unfavorableSizes = unfavorableSizes.map(s => s * 0.7);
    urgency = "LOW";
  } else if (avgSpread < 0.02) {
    favorableDeltas = favorableDeltas.map(d => d * 0.9);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 0.9);
  }
  
  // 3. Time-based compression
  if (timeRemaining > 600) {
    // Patient mode
    favorableDeltas = favorableDeltas.map(d => d * 1.2);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 1.2);
    favorableSizes = favorableSizes.map(s => s * 0.8);
    unfavorableSizes = unfavorableSizes.map(s => s * 0.8);
    orderTimeout = 45;
  } else if (timeRemaining < 300 && timeRemaining >= 180) {
    // Urgent mode
    favorableDeltas = favorableDeltas.map(d => d * 0.8);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 0.8);
    favorableSizes = favorableSizes.map(s => s * 1.2);
    unfavorableSizes = unfavorableSizes.map(s => s * 1.2);
    orderTimeout = 20;
    urgency = "URGENT";
  } else if (timeRemaining < 180) {
    // Aggressive mode (panic zone)
    favorableDeltas = favorableDeltas.map(d => d * 0.5);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 0.5);
    favorableSizes = favorableSizes.map(s => s * 1.5);
    unfavorableSizes = unfavorableSizes.map(s => s * 1.5);
    orderTimeout = 10;
    urgency = "AGGRESSIVE";
  }
  
  // 4. PAIR_COST proximity optimization
  if (pairCostDistance < 0) {
    // Already below merge threshold - focus on completing position
    urgency = "AGGRESSIVE";
  } else if (pairCostDistance < 0.02) {
    // Very close to target
    urgency = "AGGRESSIVE";
    orderTimeout = 15;
  } else if (pairCostDistance > 0.10) {
    // Far from target - defensive mode
    favorableDeltas = favorableDeltas.map(d => d * 1.5);
    unfavorableDeltas = unfavorableDeltas.map(d => d * 1.5);
    favorableSizes = favorableSizes.map(s => s * 0.6);
    unfavorableSizes = unfavorableSizes.map(s => s * 0.6);
  }
  
  return {
    favorableDeltas,
    favorableSizes,
    unfavorableDeltas,
    unfavorableSizes,
    orderTimeout,
    urgency,
  };
}

// ============================================================================
// PAIR COST CALCULATIONS (PRD §2)
// ============================================================================

function calculatePairCost(avgCostUp: number, avgCostDown: number): number {
  return avgCostUp + avgCostDown;
}

function updatePositionState(pos: LadderPosition): void {
  const { position } = pos;
  
  position.pairCost = calculatePairCost(position.avgCostUp, position.avgCostDown);
  position.inventoryImbalance = Math.abs(position.qtyUp - position.qtyDown);
  position.mergeProfit = Math.max(0, 1.0 - position.pairCost);
}

function wouldImprovePairCost(
  pos: LadderPosition,
  targetSide: "UP" | "DOWN",
  targetPrice: number,
  targetSize: number
): boolean {
  const { position } = pos;
  
  // Calculate new average cost if this order fills
  let newAvgCostUp = position.avgCostUp;
  let newAvgCostDown = position.avgCostDown;
  
  if (targetSide === "UP") {
    const totalQty = position.qtyUp + targetSize;
    if (totalQty > 0) {
      newAvgCostUp = (position.avgCostUp * position.qtyUp + targetPrice * targetSize) / totalQty;
    }
  } else {
    const totalQty = position.qtyDown + targetSize;
    if (totalQty > 0) {
      newAvgCostDown = (position.avgCostDown * position.qtyDown + targetPrice * targetSize) / totalQty;
    }
  }
  
  const newPairCost = calculatePairCost(newAvgCostUp, newAvgCostDown);
  const improvement = position.pairCost - newPairCost;
  
  return improvement >= CONFIG.minPairCostImprovement;
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  market: MarketInfo,
  postOnly: boolean = true
): Promise<string | null> {
  const client = getClient();
  
  try {
    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: side === "BUY" ? Side.BUY : Side.SELL,
        size,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC,
      false,
      postOnly
    );
    
    if (result.orderID) {
      log(`[Order] ${side} ${size.toFixed(2)} @ ${price.toFixed(4)} -> ${result.orderID.slice(0, 12)}...`);
      return result.orderID;
    }
    return null;
  } catch (err) {
    log(`[Order] Failed to place ${side} order: ${err}`);
    return null;
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  const client = getClient();
  try {
    await client.cancelOrder({ orderID: orderId });
    log(`[Order] Cancelled ${orderId.slice(0, 12)}...`);
  } catch (err) {
    log(`[Order] Failed to cancel: ${err}`);
  }
}

async function checkOrderStatus(orderId: string): Promise<{ filled: boolean; filledSize: number; avgPrice: number }> {
  try {
    const order = await getOrder(orderId);
    if (!order) {
      return { filled: true, filledSize: 0, avgPrice: 0 };
    }
    return {
      filled: order.filledSize >= order.size,
      filledSize: order.filledSize,
      avgPrice: order.price,
    };
  } catch {
    return { filled: false, filledSize: 0, avgPrice: 0 };
  }
}

// ============================================================================
// MARKET QUALITY FILTERS (PRD §5 - STATE 0)
// ============================================================================

function isMarketTradeable(market: MarketInfo, pricing: SpreadPricing, depth: ReturnType<typeof getOrderBookDepth>): boolean {
  // Check 1: Spread reasonable
  if (pricing.upSpread > CONFIG.maxEntrySpread || pricing.downSpread > CONFIG.maxEntrySpread) {
    log(`[Filter] Spread too wide: UP=${pricing.upSpread.toFixed(3)}, DOWN=${pricing.downSpread.toFixed(3)}`);
    return false;
  }
  
  // Check 2: No extreme directional bias
  if (Math.abs(pricing.upMid - 0.50) > CONFIG.maxDirectionalBias) {
    log(`[Filter] Directional bias too high: UP mid=${pricing.upMid.toFixed(3)}`);
    return false;
  }
  
  // Check 3: Order book depth
  const minDepth = Math.min(depth.upBidSize, depth.upAskSize, depth.downBidSize, depth.downAskSize);
  if (minDepth < CONFIG.minOrderBookDepth) {
    log(`[Filter] Insufficient depth: min=${minDepth.toFixed(2)}`);
    return false;
  }
  
  return true;
}

// ============================================================================
// ENTRY LOGIC (PRD §5 - STATE 1)
// ============================================================================

function determineEntrySide(pricing: SpreadPricing): { side: "UP" | "DOWN"; price: number } {
  // Buy the "richer" side (trading at premium to 0.50)
  // This creates convexity for volatility harvesting
  
  if (pricing.upMid > pricing.downMid + 0.01) {
    // UP is richer - buy UP
    return { side: "UP", price: pricing.upMid };
  } else if (pricing.downMid > pricing.upMid + 0.01) {
    // DOWN is richer - buy DOWN
    return { side: "DOWN", price: pricing.downMid };
  } else {
    // Near parity - use order book imbalance
    const upBook = wsManager.getBook(pricing.upMid.toString());
    const downBook = wsManager.getBook(pricing.downMid.toString());
    
    // Default to UP if can't determine
    return { side: "UP", price: pricing.upMid };
  }
}

function calculateSeedPrice(side: "UP" | "DOWN", midPrice: number, tickSize: number): number {
  // Place INSIDE the current ask to increase fill probability
  // Price at slight premium (we're capturing the richness)
  let entryPrice = roundToTick(midPrice + (CONFIG.seedPriceOffsetTicks * tickSize), tickSize);
  
  // Never enter above 0.54 or below 0.51
  entryPrice = Math.min(entryPrice, 0.54);
  entryPrice = Math.max(entryPrice, 0.51);
  
  return entryPrice;
}

async function placeSeedOrder(pos: LadderPosition, pricing: SpreadPricing): Promise<boolean> {
  const { market } = pos;
  const tickSize = parseFloat(market.tickSize);
  
  // Wait 10-15 seconds for initial chaos to settle
  await sleep(10000 + Math.random() * 5000);
  
  // Re-fetch pricing after observation period
  const freshPricing = await getSpreadPricing(market);
  
  // Determine entry side
  const { side, price: midPrice } = determineEntrySide(freshPricing);
  pos.seedSide = side;
  pos.seedMidPrice = midPrice;
  
  // Calculate entry price and size
  const entryPrice = calculateSeedPrice(side, midPrice, tickSize);
  const entrySize = Math.floor(CONFIG.maxPositionSize * CONFIG.seedSizePct);
  
  if (entrySize < BOT_CONFIG.minOrderSize) {
    log(`[Seed] Entry size ${entrySize} below minimum`);
    return false;
  }
  
  // Place maker limit order
  const tokenId = side === "UP" ? market.upTokenId : market.downTokenId;
  const orderId = await placeLimitOrder(tokenId, "BUY", entryPrice, entrySize, market, true);
  
  if (!orderId) {
    return false;
  }
  
  pos.seedOrderId = orderId;
  pos.seedPlacedAt = Date.now();
  pos.seedEntryPrice = entryPrice;
  
  log(`[Seed] Placed BUY ${entrySize} ${side} @ ${entryPrice.toFixed(4)}`);
  return true;
}

// ============================================================================
// ACCUMULATION LOGIC (PRD §5 - STATE 2)
// ============================================================================

function findBidmapAction(
  pos: LadderPosition,
  priceDelta: number,
  bidmap: DynamicBidmap
): { side: "same" | "opposite"; sizePct: number } | null {
  const isFavorable = priceDelta > 0; // Opposite side getting cheaper
  
  const deltas = isFavorable ? bidmap.favorableDeltas : bidmap.unfavorableDeltas;
  const sizes = isFavorable ? bidmap.favorableSizes : bidmap.unfavorableSizes;
  
  // Find the appropriate level based on price delta
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (Math.abs(priceDelta) >= deltas[i]) {
      const levelKey = `${isFavorable ? "F" : "U"}_${i}`;
      
      // Check if this level was already triggered
      if (!pos.triggeredLevels.has(levelKey)) {
        pos.triggeredLevels.add(levelKey);
        return {
          side: isFavorable ? "opposite" : "same",
          sizePct: sizes[i],
        };
      }
    }
  }
  
  return null;
}

async function executeAccumulationStep(pos: LadderPosition): Promise<void> {
  const { market, position } = pos;
  const pricing = await getSpreadPricing(market);
  const timeRemaining = getTimeToSettlement(market);
  const tickSize = parseFloat(market.tickSize);
  
  // Update price history
  pos.priceHistory.push({
    timestamp: Date.now(),
    upMid: pricing.upMid,
    downMid: pricing.downMid,
  });
  
  // Keep last 5 minutes of history
  const fiveMinAgo = Date.now() - 300000;
  pos.priceHistory = pos.priceHistory.filter(p => p.timestamp > fiveMinAgo);
  
  // Get dynamic bidmap
  const bidmap = getDynamicBidmap(pos, timeRemaining, pricing);
  
  // Calculate price delta from seed entry
  const seedSide = pos.seedSide!;
  const currentPrice = seedSide === "UP" ? pricing.upMid : pricing.downMid;
  const priceDelta = currentPrice - pos.seedMidPrice;
  
  // Determine action from bidmap
  const action = findBidmapAction(pos, priceDelta, bidmap);
  
  if (!action) {
    return; // No action needed at current price level
  }
  
  // Calculate target side and price
  let targetSide: "UP" | "DOWN";
  let targetPrice: number;
  let targetTokenId: string;
  
  if (action.side === "opposite") {
    targetSide = seedSide === "UP" ? "DOWN" : "UP";
    targetPrice = targetSide === "UP" 
      ? roundToTick(pricing.upAsk - tickSize, tickSize)
      : roundToTick(pricing.downAsk - tickSize, tickSize);
    targetTokenId = targetSide === "UP" ? market.upTokenId : market.downTokenId;
  } else {
    targetSide = seedSide;
    targetPrice = targetSide === "UP"
      ? roundToTick(pricing.upAsk - tickSize, tickSize)
      : roundToTick(pricing.downAsk - tickSize, tickSize);
    targetTokenId = targetSide === "UP" ? market.upTokenId : market.downTokenId;
  }
  
  // Calculate order size
  const remainingCapacity = CONFIG.maxPositionSize - (targetSide === "UP" ? position.qtyUp : position.qtyDown);
  const orderSize = Math.min(
    Math.floor(CONFIG.maxPositionSize * action.sizePct),
    remainingCapacity
  );
  
  if (orderSize < BOT_CONFIG.minOrderSize) {
    log(`[Accumulation] Order size ${orderSize} below minimum`);
    return;
  }
  
  // Check if this would improve PAIR_COST
  if (!wouldImprovePairCost(pos, targetSide, targetPrice, orderSize)) {
    log(`[Accumulation] Order would not improve PAIR_COST, skipping`);
    return;
  }
  
  // Check total spend limit
  const orderCost = targetPrice * orderSize;
  if (position.totalSpend + orderCost > CONFIG.maxTotalSpend) {
    log(`[Accumulation] Would exceed max spend limit`);
    return;
  }
  
  // Place the order
  const orderId = await placeLimitOrder(targetTokenId, "BUY", targetPrice, orderSize, market, true);
  
  if (orderId) {
    pos.activeOrders.set(orderId, {
      orderId,
      tokenId: targetTokenId,
      side: "BUY",
      price: targetPrice,
      size: orderSize,
      placedAt: Date.now(),
      targetSide,
    });
    
    log(`[Accumulation] BUY ${orderSize} ${targetSide} @ ${targetPrice.toFixed(4)} (${action.side} side, delta=${priceDelta.toFixed(3)})`);
  }
}

// ============================================================================
// ORDER MONITORING & FILL HANDLING
// ============================================================================

async function processOrderFills(pos: LadderPosition): Promise<void> {
  const { position } = pos;
  const ordersToRemove: string[] = [];
  
  for (const [orderId, order] of pos.activeOrders) {
    const status = await checkOrderStatus(orderId);
    
    if (status.filledSize > 0) {
      // Process fill
      const fillCost = status.filledSize * order.price;
      
      if (order.targetSide === "UP") {
        const newQty = position.qtyUp + status.filledSize;
        position.avgCostUp = (position.avgCostUp * position.qtyUp + fillCost) / newQty;
        position.qtyUp = newQty;
      } else {
        const newQty = position.qtyDown + status.filledSize;
        position.avgCostDown = (position.avgCostDown * position.qtyDown + fillCost) / newQty;
        position.qtyDown = newQty;
      }
      
      position.totalSpend += fillCost;
      updatePositionState(pos);
      
      log(`[Fill] ${status.filledSize} ${order.targetSide} @ ${order.price.toFixed(4)} | PAIR_COST: ${position.pairCost.toFixed(4)}`);
      
      // Check merge condition
      if (position.pairCost < CONFIG.mergeThreshold && position.qtyUp > 0 && position.qtyDown > 0) {
        log(`[Fill] MERGE CONDITION MET! PAIR_COST=${position.pairCost.toFixed(4)} < ${CONFIG.mergeThreshold}`);
        pos.state = LadderState.EXIT_MERGE;
      }
    }
    
    if (status.filled) {
      ordersToRemove.push(orderId);
    }
    
    // Check for stale orders
    const orderAge = (Date.now() - order.placedAt) / 1000;
    const bidmap = getDynamicBidmap(pos, getTimeToSettlement(pos.market), await getSpreadPricing(pos.market));
    
    if (orderAge > bidmap.orderTimeout) {
      log(`[Order] Cancelling stale order ${orderId.slice(0, 12)}... (${orderAge.toFixed(0)}s old)`);
      await cancelOrder(orderId);
      ordersToRemove.push(orderId);
    }
  }
  
  for (const orderId of ordersToRemove) {
    pos.activeOrders.delete(orderId);
  }
}

// ============================================================================
// EXIT LOGIC (PRD §5 - STATE 4)
// ============================================================================

async function executeMerge(pos: LadderPosition): Promise<void> {
  const { market, position } = pos;
  
  // Cancel all open orders
  await cancelOrdersForMarket(market.conditionId);
  pos.activeOrders.clear();
  
  // Calculate mergeable amount
  const mergeableAmount = Math.min(position.qtyUp, position.qtyDown);
  
  if (mergeableAmount < 1) {
    log(`[Merge] Insufficient balance for merge: UP=${position.qtyUp.toFixed(2)}, DOWN=${position.qtyDown.toFixed(2)}`);
    pos.state = LadderState.EXIT_TIME_STOP;
    return;
  }
  
  try {
    log(`[Merge] Merging ${mergeableAmount.toFixed(2)} pairs for $${mergeableAmount.toFixed(2)}...`);
    await mergePositions(market, mergeableAmount);
    
    const profit = mergeableAmount - (position.avgCostUp + position.avgCostDown) * mergeableAmount;
    pos.realizedPnL = profit;
    pos.exitReason = "MERGE_SUCCESS";
    
    log(`[Merge] SUCCESS! Profit: $${profit.toFixed(4)}`);
    pos.state = LadderState.CLOSED;
  } catch (err) {
    log(`[Merge] Failed: ${err}`);
    pos.state = LadderState.EXIT_TIME_STOP;
  }
}

async function executePanicCapture(pos: LadderPosition): Promise<void> {
  const { market, position } = pos;
  const pricing = await getSpreadPricing(market);
  
  // Look for extreme certainty (one side very cheap)
  if (pricing.upAsk < 0.25) {
    log(`[Panic] UP extremely cheap @ ${pricing.upAsk.toFixed(3)} - accumulating`);
    const size = Math.min(CONFIG.maxPositionSize - position.qtyUp, CONFIG.maxPositionSize * 0.5);
    if (size >= BOT_CONFIG.minOrderSize) {
      await placeLimitOrder(market.upTokenId, "BUY", pricing.upAsk, size, market, false);
    }
  } else if (pricing.downAsk < 0.25) {
    log(`[Panic] DOWN extremely cheap @ ${pricing.downAsk.toFixed(3)} - accumulating`);
    const size = Math.min(CONFIG.maxPositionSize - position.qtyDown, CONFIG.maxPositionSize * 0.5);
    if (size >= BOT_CONFIG.minOrderSize) {
      await placeLimitOrder(market.downTokenId, "BUY", pricing.downAsk, size, market, false);
    }
  }
  
  // After panic capture, try to merge
  await processOrderFills(pos);
  
  if (position.qtyUp > 0 && position.qtyDown > 0) {
    pos.state = LadderState.EXIT_MERGE;
  } else {
    pos.state = LadderState.EXIT_TIME_STOP;
  }
}

async function executeTimeStop(pos: LadderPosition): Promise<void> {
  const { market, position } = pos;
  
  // Cancel all orders
  await cancelOrdersForMarket(market.conditionId);
  pos.activeOrders.clear();
  
  // Try to merge what we have
  const mergeableAmount = Math.min(position.qtyUp, position.qtyDown);
  
  if (mergeableAmount >= 1) {
    try {
      log(`[TimeStop] Emergency merge of ${mergeableAmount.toFixed(2)} pairs`);
      await mergePositions(market, mergeableAmount);
      position.qtyUp -= mergeableAmount;
      position.qtyDown -= mergeableAmount;
    } catch (err) {
      log(`[TimeStop] Merge failed: ${err}`);
    }
  }
  
  // Calculate realized P&L
  const pricing = await getSpreadPricing(market);
  const remainingValue = position.qtyUp * pricing.upBid + position.qtyDown * pricing.downBid;
  pos.realizedPnL = remainingValue + mergeableAmount - position.totalSpend;
  pos.exitReason = "TIME_STOP";
  
  log(`[TimeStop] Exit complete. PnL: $${pos.realizedPnL.toFixed(4)}`);
  pos.state = LadderState.CLOSED;
}

// ============================================================================
// STATE MACHINE EXECUTION
// ============================================================================

async function processPosition(pos: LadderPosition): Promise<void> {
  const timeRemaining = getTimeToSettlement(pos.market);
  
  // Check time-based exits
  if (timeRemaining < CONFIG.forceExitSec && pos.state !== LadderState.EXIT_MERGE && pos.state !== LadderState.CLOSED) {
    log(`[State] Force exit - ${timeRemaining.toFixed(0)}s remaining`);
    pos.state = LadderState.EXIT_TIME_STOP;
  } else if (timeRemaining < CONFIG.timeStopSec && pos.state === LadderState.DYNAMIC_ACCUMULATION) {
    if (pos.position.pairCost > CONFIG.mergeThreshold) {
      log(`[State] Time stop triggered - PAIR_COST=${pos.position.pairCost.toFixed(4)} > ${CONFIG.mergeThreshold}`);
      pos.state = LadderState.EXIT_TIME_STOP;
    }
  }
  
  // Check for panic capture opportunity
  if (timeRemaining < 120 && pos.state === LadderState.DYNAMIC_ACCUMULATION) {
    const pricing = await getSpreadPricing(pos.market);
    if (pricing.upAsk < 0.25 || pricing.downAsk < 0.25) {
      log(`[State] Panic capture opportunity detected`);
      pos.state = LadderState.EXIT_PANIC_CAPTURE;
    }
  }
  
  // Check risk limits
  if (pos.position.totalSpend > CONFIG.maxTotalSpend) {
    log(`[State] Risk stop - total spend ${pos.position.totalSpend.toFixed(2)} > ${CONFIG.maxTotalSpend}`);
    pos.state = LadderState.EXIT_RISK_STOP;
  }
  
  switch (pos.state) {
    case LadderState.INVENTORY_SEED: {
      // Check seed order status
      if (pos.seedOrderId) {
        const status = await checkOrderStatus(pos.seedOrderId);
        const elapsed = (Date.now() - (pos.seedPlacedAt || 0)) / 1000;
        
        if (status.filledSize > 0) {
          // Process fill
          const fillCost = status.filledSize * pos.seedEntryPrice;
          
          if (pos.seedSide === "UP") {
            pos.position.qtyUp = status.filledSize;
            pos.position.avgCostUp = pos.seedEntryPrice;
          } else {
            pos.position.qtyDown = status.filledSize;
            pos.position.avgCostDown = pos.seedEntryPrice;
          }
          pos.position.totalSpend = fillCost;
          updatePositionState(pos);
          
          log(`[Seed] Filled ${status.filledSize} ${pos.seedSide} @ ${pos.seedEntryPrice.toFixed(4)}`);
          
          if (status.filled || status.filledSize >= CONFIG.minViablePosition) {
            // Full or acceptable partial fill - proceed to accumulation
            if (!status.filled) {
              await cancelOrder(pos.seedOrderId);
            }
            pos.state = LadderState.DYNAMIC_ACCUMULATION;
            log(`[State] -> DYNAMIC_ACCUMULATION`);
          }
        } else if (elapsed > CONFIG.seedTimeoutSec) {
          // Timeout - no fill, skip this market
          log(`[Seed] Timeout after ${elapsed.toFixed(0)}s - skipping market`);
          await cancelOrder(pos.seedOrderId);
          pos.exitReason = "SEED_TIMEOUT";
          pos.state = LadderState.CLOSED;
        }
      }
      break;
    }
    
    case LadderState.DYNAMIC_ACCUMULATION: {
      // Process any order fills
      await processOrderFills(pos);
      
      // Check if merge condition met
      if (pos.position.pairCost < CONFIG.mergeThreshold && pos.position.qtyUp > 0 && pos.position.qtyDown > 0) {
        pos.state = LadderState.EXIT_MERGE;
        break;
      }
      
      // Execute accumulation step
      await executeAccumulationStep(pos);
      break;
    }
    
    case LadderState.EXIT_MERGE: {
      await executeMerge(pos);
      break;
    }
    
    case LadderState.EXIT_PANIC_CAPTURE: {
      await executePanicCapture(pos);
      break;
    }
    
    case LadderState.EXIT_TIME_STOP:
    case LadderState.EXIT_RISK_STOP: {
      await executeTimeStop(pos);
      break;
    }
  }
}

// ============================================================================
// MARKET SCANNER
// ============================================================================

async function scanForOpportunities(): Promise<void> {
  if (activePositions.size >= CONFIG.maxConcurrentMarkets) {
    return;
  }
  
  const markets = await fetchCryptoMarkets({ type: CONFIG.marketType });
  
  for (const market of markets) {
    if (activePositions.has(market.conditionId)) continue;
    if (activePositions.size >= CONFIG.maxConcurrentMarkets) break;
    
    const timeRemaining = getTimeToSettlement(market);
    
    // Need at least 14 minutes for full strategy
    if (timeRemaining < 840) {
      log(`[Scan] Skipping ${market.question.slice(0, 30)}... - only ${timeRemaining.toFixed(0)}s remaining`);
      continue;
    }
    
    // Subscribe to websocket
    wsManager.subscribeMarket(market);
    await sleep(1000); // Wait for initial data
    
    // Get pricing and depth
    const pricing = await getSpreadPricing(market);
    const depth = getOrderBookDepth(market);
    
    // Check market quality
    if (!isMarketTradeable(market, pricing, depth)) {
      log(`[Scan] Market failed quality checks`);
      wsManager.unsubscribeMarket(market);
      continue;
    }
    
    // Create position
    const pos: LadderPosition = {
      market,
      state: LadderState.INVENTORY_SEED,
      
      seedSide: null,
      seedOrderId: null,
      seedPlacedAt: null,
      seedEntryPrice: 0,
      seedMidPrice: 0,
      
      position: {
        qtyUp: 0,
        qtyDown: 0,
        avgCostUp: 0,
        avgCostDown: 0,
        pairCost: 0,
        inventoryImbalance: 0,
        totalSpend: 0,
        maxLoss: 0,
        mergeProfit: 0,
      },
      
      activeOrders: new Map(),
      triggeredLevels: new Set(),
      lastBidmapCheck: Date.now(),
      
      lastUpMid: pricing.upMid,
      lastDownMid: pricing.downMid,
      priceHistory: [],
      
      entryTime: new Date(),
      realizedPnL: 0,
      exitReason: null,
    };
    
    // Place seed order
    const success = await placeSeedOrder(pos, pricing);
    if (success) {
      activePositions.set(market.conditionId, pos);
      log(`[Scan] Started position: ${market.question.slice(0, 50)}...`);
    } else {
      wsManager.unsubscribeMarket(market);
    }
  }
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function mainLoop(): Promise<void> {
  await scanForOpportunities();
  
  while (isRunning) {
    // Check for window transitions
    const window15mChanged = hasWindowChanged("15m");
    
    if (window15mChanged) {
      const windowStart = getCurrentWindowStart(15 * 60);
      log(`\n${"═".repeat(60)}`);
      log(`NEW 15-MIN WINDOW: ${formatWindowTime(windowStart)}`);
      log(`${"═".repeat(60)}`);
    }
    
    // Process active positions
    for (const [conditionId, pos] of activePositions) {
      try {
        await processPosition(pos);
        
        if (pos.state === LadderState.CLOSED) {
          totalPnL += pos.realizedPnL;
          log(`[Position] Closed: ${pos.exitReason} | PnL: $${pos.realizedPnL.toFixed(4)} | Total: $${totalPnL.toFixed(4)}`);
          wsManager.unsubscribeMarket(pos.market);
          activePositions.delete(conditionId);
        }
      } catch (err) {
        log(`[Error] Processing position: ${err}`);
      }
    }
    
    // Scan for new opportunities on window change
    if (window15mChanged || activePositions.size < CONFIG.maxConcurrentMarkets) {
      await scanForOpportunities();
    }
    
    // Status update
    if (activePositions.size > 0) {
      for (const [_, pos] of activePositions) {
        const timeRemaining = getTimeToSettlement(pos.market);
        log(`[Status] ${pos.state} | PAIR_COST: ${pos.position.pairCost.toFixed(4)} | UP: ${pos.position.qtyUp.toFixed(2)} @ ${pos.position.avgCostUp.toFixed(3)} | DOWN: ${pos.position.qtyDown.toFixed(2)} @ ${pos.position.avgCostDown.toFixed(3)} | Time: ${timeRemaining.toFixed(0)}s`);
      }
    } else {
      log(`[Status] Waiting for opportunities...`);
    }
    
    await sleep(CONFIG.pollIntervalMs);
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log("  VOLATILITY LADDER - Merge Arbitrage Strategy");
  console.log("═".repeat(70));
  console.log("\nConfiguration:");
  console.log(`  Market type:        ${CONFIG.marketType.toUpperCase()}`);
  console.log(`  Merge threshold:    $${CONFIG.mergeThreshold.toFixed(3)}`);
  console.log(`  Max position size:  ${CONFIG.maxPositionSize}`);
  console.log(`  Max total spend:    $${CONFIG.maxTotalSpend.toFixed(2)}`);
  console.log(`  Time stop:          ${CONFIG.timeStopSec}s before resolution`);
  console.log(`  Max concurrent:     ${CONFIG.maxConcurrentMarkets} markets`);
  console.log("\nBidmap (Favorable Moves):");
  for (const level of CONFIG.favorableMoves) {
    console.log(`  +${(level.priceDelta * 100).toFixed(0)}¢ -> ${(level.sizePct * 100).toFixed(0)}% of max`);
  }
  console.log("\nBidmap (Unfavorable Moves - Average Down):");
  for (const level of CONFIG.unfavorableMoves) {
    console.log(`  -${(level.priceDelta * 100).toFixed(0)}¢ -> ${(level.sizePct * 100).toFixed(0)}% of max`);
  }
  console.log("═".repeat(70));
  
  // Initialize
  await initClient();
  
  log("Connecting to WebSocket...");
  await wsManager.connect();
  
  const wallet = await getWalletBalance();
  log(`Wallet: $${wallet.usdcBalance.toFixed(2)} USDC | Holdings: $${wallet.holdingsValue.toFixed(2)}`);
  
  isRunning = true;
  
  process.on("SIGINT", async () => {
    log("\nShutting down...");
    isRunning = false;
    
    // Cancel all orders
    for (const [conditionId, pos] of activePositions) {
      await cancelOrdersForMarket(pos.market.conditionId);
    }
    
    wsManager.disconnect();
    log(`Session complete. Total PnL: $${totalPnL.toFixed(4)}`);
    process.exit(0);
  });
  
  await mainLoop();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
