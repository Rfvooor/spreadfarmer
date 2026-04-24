import { OrderType, Side } from "@polymarket/clob-client";
import { getClient, initClient } from "./client.js";
import { BOT_CONFIG, CLOB_HOST } from "./config.js";
import { fetchCryptoMarkets, getTimeToSettlement, hasWindowChanged, getCurrentWindowStart, formatWindowTime, type MarketType } from "./markets.js";
import { roundToTick } from "./pricing.js";
import { cancelOrdersForMarket, marketSell, getOpenOrders } from "./orders.js";
import { splitPosition } from "./split-merge.js";
import type { MarketInfo, OrderInfo } from "./types.js";
import { getWalletBalance } from "./wallet.js";
import { wsManager } from "./websocket.js";

interface SpreadConfig {
  marginFromMid: number;       // e.g., 0.02 = place orders 2% from mid
  orderSizeUSD: number;        // size per side
  timeToExpireSec: number;     // cancel unfilled orders after this
  maxLossPct: number;          // stop loss as % of position
  minSpreadToEnter: number;    // minimum spread required (bid sum < 1-spread OR ask sum > 1+spread)
  maxActivePositions: number;
  pollIntervalMs: number;
  enableAskSide: boolean;      // enable selling pre-split inventory when asks sum > 1
  enableBidSide: boolean;      // enable buying when bids sum < 1
  preSplitUSD: number;         // USDC to pre-split for ask-side inventory
  marketType: MarketType;      // "15m", "5m", or "all"
}

const SPREAD_CONFIG: SpreadConfig = {
  marginFromMid: parseFloat(process.env.MARGIN_FROM_MID || "0.02"),
  orderSizeUSD: parseFloat(process.env.ORDER_SIZE_USD || "50"),
  timeToExpireSec: parseFloat(process.env.TIME_TO_EXPIRE_SEC || "120"),
  maxLossPct: parseFloat(process.env.MAX_LOSS_PCT || "0.05"),
  minSpreadToEnter: parseFloat(process.env.MIN_SPREAD_TO_ENTER || "0.02"),
  maxActivePositions: parseInt(process.env.MAX_ACTIVE_POSITIONS || "10"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000"), // Faster with websockets
  enableAskSide: process.env.ENABLE_ASK_SIDE !== "false",
  enableBidSide: process.env.ENABLE_BID_SIDE !== "false",
  preSplitUSD: parseFloat(process.env.PRE_SPLIT_USD || "100"),
  marketType: (process.env.MARKET_TYPE || "all") as MarketType,
};

enum PositionState {
  IDLE = "IDLE",
  QUOTING = "QUOTING",           // both sides quoted, waiting for first fill
  ONE_SIDED = "ONE_SIDED",       // one side filled, waiting for other
  STOPPING_OUT = "STOPPING_OUT", // exiting due to stop loss/time
  CLOSED = "CLOSED",
}

type PositionDirection = "BID" | "ASK";  // BID = buying both sides, ASK = selling both sides

interface SpreadPosition {
  market: MarketInfo;
  state: PositionState;
  direction: PositionDirection;
  
  // Orders
  upOrderId: string | null;
  downOrderId: string | null;
  upPrice: number;
  downPrice: number;
  
  // Position (for one-sided fills)
  filledSide: "UP" | "DOWN" | null;
  filledPrice: number;
  filledSize: number;
  
  // Pre-split inventory (for ASK direction)
  upInventory: number;
  downInventory: number;
  
  // Timing
  entryTime: Date;
  orderPlacedTime: Date | null;
  
  // PnL tracking
  realizedPnL: number;
}

const activePositions: Map<string, SpreadPosition> = new Map();
let isRunning = false;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface SpreadPricing {
  upBid: number;
  upAsk: number;
  upMid: number;
  downBid: number;
  downAsk: number;
  downMid: number;
  bidSum: number;    // upBid + downBid - what you'd pay to buy both
  askSum: number;    // upAsk + downAsk - what you'd receive selling both
  spread: number;    // askSum - bidSum
  fairMid: number;
  fromWebsocket: boolean;
}

function getSpreadPricingFromWS(market: MarketInfo): SpreadPricing | null {
  const upBid = wsManager.getBestBid(market.upTokenId);
  const upAsk = wsManager.getBestAsk(market.upTokenId);
  const downBid = wsManager.getBestBid(market.downTokenId);
  const downAsk = wsManager.getBestAsk(market.downTokenId);
  
  // If no data yet, return null
  if (upBid === 0 && upAsk === 1 && downBid === 0 && downAsk === 1) {
    return null;
  }
  
  const upMid = (upBid + upAsk) / 2;
  const downMid = (downBid + downAsk) / 2;
  const bidSum = upBid + downBid;
  const askSum = upAsk + downAsk;
  const spread = askSum - bidSum;
  const fairMid = (upMid + (1 - downMid)) / 2;
  
  return {
    upBid,
    upAsk,
    upMid,
    downBid,
    downAsk,
    downMid,
    bidSum,
    askSum,
    spread,
    fairMid,
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
  const spread = askSum - bidSum;
  const fairMid = (upMid + (1 - downMid)) / 2;
  
  return {
    upBid,
    upAsk,
    upMid,
    downBid,
    downAsk,
    downMid,
    bidSum,
    askSum,
    spread,
    fairMid,
    fromWebsocket: false,
  };
}

async function getSpreadPricing(market: MarketInfo): Promise<SpreadPricing> {
  // Try websocket first (faster, real-time)
  const wsData = getSpreadPricingFromWS(market);
  if (wsData) {
    return wsData;
  }
  
  // Fall back to REST
  return getSpreadPricingFromREST(market);
}

async function placeLimitOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  market: MarketInfo
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
      true // postOnly
    );
    
    if (result.orderID) {
      log(`Placed ${side} ${size} @ ${price.toFixed(4)} -> ${result.orderID.slice(0, 12)}...`);
      return result.orderID;
    }
    return null;
  } catch (err) {
    log(`Failed to place ${side} order: ${err}`);
    return null;
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  const client = getClient();
  try {
    await client.cancelOrder({ orderID: orderId });
    log(`Cancelled order ${orderId.slice(0, 12)}...`);
  } catch (err) {
    log(`Failed to cancel order: ${err}`);
  }
}

async function checkOrderFilled(orderId: string): Promise<{ filled: boolean; filledSize: number; avgPrice: number }> {
  const client = getClient();
  try {
    const order = await client.getOrder(orderId);
    if (!order) {
      return { filled: true, filledSize: 0, avgPrice: 0 };
    }
    
    const originalSize = parseFloat(order.original_size);
    const remainingSize = parseFloat(order.size_matched);
    const filledSize = originalSize - remainingSize;
    const avgPrice = parseFloat(order.price);
    
    return {
      filled: remainingSize === 0,
      filledSize,
      avgPrice,
    };
  } catch {
    return { filled: false, filledSize: 0, avgPrice: 0 };
  }
}

async function placeBidSpreadOrders(pos: SpreadPosition, pricing: SpreadPricing): Promise<boolean> {
  const { market } = pos;
  const tickSize = parseFloat(market.tickSize);
  
  // BID strategy: buy both sides when bidSum < 1 - margin
  // Profit = $1 (at settlement) - cost
  const targetBidSum = 1 - SPREAD_CONFIG.minSpreadToEnter;
  
  if (pricing.bidSum > targetBidSum) {
    log(`  Bid sum too high: ${pricing.bidSum.toFixed(4)} > ${targetBidSum.toFixed(4)}`);
    return false;
  }
  
  // Place bids at current best bid or slightly below
  const upBuyPrice = roundToTick(Math.max(0.001, pricing.upBid - SPREAD_CONFIG.marginFromMid), tickSize);
  const downBuyPrice = roundToTick(Math.max(0.001, pricing.downBid - SPREAD_CONFIG.marginFromMid), tickSize);
  
  const upSize = Math.floor(SPREAD_CONFIG.orderSizeUSD / upBuyPrice);
  const downSize = Math.floor(SPREAD_CONFIG.orderSizeUSD / downBuyPrice);
  
  log(`  [BID] Placing BUY UP @ ${upBuyPrice.toFixed(3)} (${upSize} shares)`);
  log(`  [BID] Placing BUY DOWN @ ${downBuyPrice.toFixed(3)} (${downSize} shares)`);
  log(`  [BID] Target cost: $${(upBuyPrice * upSize + downBuyPrice * downSize).toFixed(2)} for ${Math.min(upSize, downSize)} pairs`);
  
  const [upOrderId, downOrderId] = await Promise.all([
    placeLimitOrder(market.upTokenId, "BUY", upBuyPrice, upSize, market),
    placeLimitOrder(market.downTokenId, "BUY", downBuyPrice, downSize, market),
  ]);
  
  if (!upOrderId || !downOrderId) {
    if (upOrderId) await cancelOrder(upOrderId);
    if (downOrderId) await cancelOrder(downOrderId);
    return false;
  }
  
  pos.direction = "BID";
  pos.upOrderId = upOrderId;
  pos.downOrderId = downOrderId;
  pos.upPrice = upBuyPrice;
  pos.downPrice = downBuyPrice;
  pos.orderPlacedTime = new Date();
  pos.state = PositionState.QUOTING;
  
  return true;
}

async function placeAskSpreadOrders(pos: SpreadPosition, pricing: SpreadPricing): Promise<boolean> {
  const { market } = pos;
  const tickSize = parseFloat(market.tickSize);
  
  // ASK strategy: sell both sides when askSum > 1 + margin
  // Profit = proceeds - $1 (cost of split inventory)
  const targetAskSum = 1 + SPREAD_CONFIG.minSpreadToEnter;
  
  if (pricing.askSum < targetAskSum) {
    log(`  Ask sum too low: ${pricing.askSum.toFixed(4)} < ${targetAskSum.toFixed(4)}`);
    return false;
  }
  
  // Need inventory to sell - check if we have it or need to split
  if (pos.upInventory === 0 || pos.downInventory === 0) {
    log(`  [ASK] Splitting $${SPREAD_CONFIG.preSplitUSD} for inventory...`);
    try {
      const { upTokens, downTokens } = await splitPosition(market, SPREAD_CONFIG.preSplitUSD);
      pos.upInventory = upTokens;
      pos.downInventory = downTokens;
      log(`  [ASK] Split complete: ${upTokens} UP + ${downTokens} DOWN`);
    } catch (err) {
      log(`  [ASK] Split failed: ${err}`);
      return false;
    }
  }
  
  // Place asks at current best ask or slightly above
  const upSellPrice = roundToTick(Math.min(0.999, pricing.upAsk + SPREAD_CONFIG.marginFromMid), tickSize);
  const downSellPrice = roundToTick(Math.min(0.999, pricing.downAsk + SPREAD_CONFIG.marginFromMid), tickSize);
  
  // Use available inventory, capped by order size
  const maxShares = Math.floor(SPREAD_CONFIG.orderSizeUSD / 0.5); // ~shares at mid price
  const upSize = Math.min(pos.upInventory, maxShares);
  const downSize = Math.min(pos.downInventory, maxShares);
  
  if (upSize <= 0 || downSize <= 0) {
    log(`  [ASK] Insufficient inventory: ${pos.upInventory} UP, ${pos.downInventory} DOWN`);
    return false;
  }
  
  log(`  [ASK] Placing SELL UP @ ${upSellPrice.toFixed(3)} (${upSize} shares)`);
  log(`  [ASK] Placing SELL DOWN @ ${downSellPrice.toFixed(3)} (${downSize} shares)`);
  log(`  [ASK] Target proceeds: $${(upSellPrice * upSize + downSellPrice * downSize).toFixed(2)}`);
  
  const [upOrderId, downOrderId] = await Promise.all([
    placeLimitOrder(market.upTokenId, "SELL", upSellPrice, upSize, market),
    placeLimitOrder(market.downTokenId, "SELL", downSellPrice, downSize, market),
  ]);
  
  if (!upOrderId || !downOrderId) {
    if (upOrderId) await cancelOrder(upOrderId);
    if (downOrderId) await cancelOrder(downOrderId);
    return false;
  }
  
  pos.direction = "ASK";
  pos.upOrderId = upOrderId;
  pos.downOrderId = downOrderId;
  pos.upPrice = upSellPrice;
  pos.downPrice = downSellPrice;
  pos.orderPlacedTime = new Date();
  pos.state = PositionState.QUOTING;
  
  return true;
}

async function placeSpreadOrders(pos: SpreadPosition): Promise<boolean> {
  const { market } = pos;
  const pricing = await getSpreadPricing(market);
  
  log(`${market.question.slice(0, 50)}...`);
  log(`  UP: ${pricing.upBid.toFixed(3)}/${pricing.upAsk.toFixed(3)} | DOWN: ${pricing.downBid.toFixed(3)}/${pricing.downAsk.toFixed(3)}`);
  log(`  Bid sum: ${pricing.bidSum.toFixed(3)} | Ask sum: ${pricing.askSum.toFixed(3)} | Spread: ${(pricing.spread * 100).toFixed(2)}%`);
  
  // Try ASK side first (sell when asks sum > 1)
  if (SPREAD_CONFIG.enableAskSide && pricing.askSum > 1 + SPREAD_CONFIG.minSpreadToEnter) {
    log(`  [ASK] Opportunity: ask sum ${pricing.askSum.toFixed(3)} > 1 + ${SPREAD_CONFIG.minSpreadToEnter}`);
    return await placeAskSpreadOrders(pos, pricing);
  }
  
  // Try BID side (buy when bids sum < 1)
  if (SPREAD_CONFIG.enableBidSide && pricing.bidSum < 1 - SPREAD_CONFIG.minSpreadToEnter) {
    log(`  [BID] Opportunity: bid sum ${pricing.bidSum.toFixed(3)} < 1 - ${SPREAD_CONFIG.minSpreadToEnter}`);
    return await placeBidSpreadOrders(pos, pricing);
  }
  
  log(`  No opportunity: bid sum ${pricing.bidSum.toFixed(3)}, ask sum ${pricing.askSum.toFixed(3)}`);
  return false;
}

async function handleQuotingState(pos: SpreadPosition): Promise<void> {
  const now = Date.now();
  const orderAge = pos.orderPlacedTime ? (now - pos.orderPlacedTime.getTime()) / 1000 : 0;
  const timeRemaining = getTimeToSettlement(pos.market);
  
  // Check if orders expired
  if (orderAge > SPREAD_CONFIG.timeToExpireSec) {
    log(`Orders expired after ${orderAge.toFixed(0)}s, cancelling...`);
    if (pos.upOrderId) await cancelOrder(pos.upOrderId);
    if (pos.downOrderId) await cancelOrder(pos.downOrderId);
    pos.state = PositionState.CLOSED;
    return;
  }
  
  // Force exit if market about to settle
  if (timeRemaining < BOT_CONFIG.risk.panicTimeSec) {
    log(`Panic time! Market settling in ${timeRemaining.toFixed(0)}s`);
    if (pos.upOrderId) await cancelOrder(pos.upOrderId);
    if (pos.downOrderId) await cancelOrder(pos.downOrderId);
    pos.state = PositionState.CLOSED;
    return;
  }
  
  // Check for fills
  const [upStatus, downStatus] = await Promise.all([
    pos.upOrderId ? checkOrderFilled(pos.upOrderId) : { filled: false, filledSize: 0, avgPrice: 0 },
    pos.downOrderId ? checkOrderFilled(pos.downOrderId) : { filled: false, filledSize: 0, avgPrice: 0 },
  ]);
  
  if (upStatus.filled && downStatus.filled) {
    // Both filled - calculate PnL based on direction
    const upAmount = upStatus.filledSize * upStatus.avgPrice;
    const downAmount = downStatus.filledSize * downStatus.avgPrice;
    const minShares = Math.min(upStatus.filledSize, downStatus.filledSize);
    
    if (pos.direction === "BID") {
      // BID: bought both sides, profit = $1 per pair - cost
      const totalCost = upAmount + downAmount;
      pos.realizedPnL = minShares - totalCost;
    } else {
      // ASK: sold both sides, profit = proceeds - $1 per pair (inventory cost)
      const totalProceeds = upAmount + downAmount;
      pos.realizedPnL = totalProceeds - minShares;
    }
    
    log(`[${pos.direction}] Both sides filled! PnL: $${pos.realizedPnL.toFixed(4)}`);
    pos.state = PositionState.CLOSED;
    return;
  }
  
  if (upStatus.filled && !downStatus.filled) {
    log(`UP side filled @ ${upStatus.avgPrice.toFixed(4)}, waiting for DOWN...`);
    pos.filledSide = "UP";
    pos.filledPrice = upStatus.avgPrice;
    pos.filledSize = upStatus.filledSize;
    pos.state = PositionState.ONE_SIDED;
    return;
  }
  
  if (downStatus.filled && !upStatus.filled) {
    log(`DOWN side filled @ ${downStatus.avgPrice.toFixed(4)}, waiting for UP...`);
    pos.filledSide = "DOWN";
    pos.filledPrice = downStatus.avgPrice;
    pos.filledSize = downStatus.filledSize;
    pos.state = PositionState.ONE_SIDED;
    return;
  }
}

async function handleOneSidedState(pos: SpreadPosition): Promise<void> {
  const timeRemaining = getTimeToSettlement(pos.market);
  const pricing = await getSpreadPricing(pos.market);
  
  // Calculate current P&L based on direction
  const filledAmount = pos.filledSize * pos.filledPrice;
  let unrealizedPnL: number;
  
  if (pos.direction === "BID") {
    // We bought one side - can we sell it back?
    const exitPrice = pos.filledSide === "UP" ? pricing.upBid : pricing.downBid;
    unrealizedPnL = (exitPrice - pos.filledPrice) * pos.filledSize;
  } else {
    // We sold one side - would need to buy back or let settle
    const buybackPrice = pos.filledSide === "UP" ? pricing.upAsk : pricing.downAsk;
    unrealizedPnL = (pos.filledPrice - buybackPrice) * pos.filledSize;
  }
  
  const lossThreshold = -filledAmount * SPREAD_CONFIG.maxLossPct;
  
  log(`[${pos.direction}] One-sided ${pos.filledSide} | Unrealized: $${unrealizedPnL.toFixed(4)} | Threshold: $${lossThreshold.toFixed(4)}`);
  
  // Stop loss
  if (unrealizedPnL < lossThreshold) {
    log(`Stop loss triggered! Closing position...`);
    pos.state = PositionState.STOPPING_OUT;
    return;
  }
  
  // Force exit before resolution
  if (timeRemaining < BOT_CONFIG.risk.panicTimeSec) {
    log(`Panic time! Closing position...`);
    pos.state = PositionState.STOPPING_OUT;
    return;
  }
  
  // Check if other side filled
  const pendingOrderId = pos.filledSide === "UP" ? pos.downOrderId : pos.upOrderId;
  if (pendingOrderId) {
    const status = await checkOrderFilled(pendingOrderId);
    if (status.filled) {
      const otherAmount = status.filledSize * status.avgPrice;
      const minShares = Math.min(pos.filledSize, status.filledSize);
      
      if (pos.direction === "BID") {
        const totalCost = filledAmount + otherAmount;
        pos.realizedPnL = minShares - totalCost;
      } else {
        const totalProceeds = filledAmount + otherAmount;
        pos.realizedPnL = totalProceeds - minShares;
      }
      
      log(`[${pos.direction}] Other side filled! Total PnL: $${pos.realizedPnL.toFixed(4)}`);
      pos.state = PositionState.CLOSED;
    }
  }
}

async function handleStoppingOut(pos: SpreadPosition): Promise<void> {
  const { market } = pos;
  
  // Cancel any pending orders
  if (pos.upOrderId) await cancelOrder(pos.upOrderId);
  if (pos.downOrderId) await cancelOrder(pos.downOrderId);
  
  // Handle one-sided fill
  if (pos.filledSide && pos.filledSize > 0) {
    const tokenId = pos.filledSide === "UP" ? market.upTokenId : market.downTokenId;
    const pricing = await getSpreadPricing(market);
    
    if (pos.direction === "BID") {
      // We bought one side - sell it back
      log(`[BID] Market selling ${pos.filledSize} ${pos.filledSide} shares...`);
      const success = await marketSell(tokenId, pos.filledSize, market);
      if (success) {
        const exitPrice = pos.filledSide === "UP" ? pricing.upBid : pricing.downBid;
        pos.realizedPnL = (exitPrice - pos.filledPrice) * pos.filledSize;
        log(`[BID] Exited at ~${exitPrice.toFixed(3)}, PnL: $${pos.realizedPnL.toFixed(4)}`);
      }
    } else {
      // We sold one side (ASK) - the inventory is gone, calculate partial PnL
      // Remaining inventory can be held or merged
      const proceeds = pos.filledSize * pos.filledPrice;
      const inventoryCost = pos.filledSize; // $1 per share cost basis
      pos.realizedPnL = proceeds - inventoryCost;
      log(`[ASK] Sold ${pos.filledSize} ${pos.filledSide} @ ${pos.filledPrice.toFixed(3)} | PnL: $${pos.realizedPnL.toFixed(4)}`);
      
      // Update remaining inventory
      if (pos.filledSide === "UP") {
        pos.upInventory -= pos.filledSize;
      } else {
        pos.downInventory -= pos.filledSize;
      }
    }
  }
  
  pos.state = PositionState.CLOSED;
}

async function processPosition(pos: SpreadPosition): Promise<void> {
  switch (pos.state) {
    case PositionState.QUOTING:
      await handleQuotingState(pos);
      break;
    case PositionState.ONE_SIDED:
      await handleOneSidedState(pos);
      break;
    case PositionState.STOPPING_OUT:
      await handleStoppingOut(pos);
      break;
  }
}

async function scanForOpportunities(): Promise<void> {
  if (activePositions.size >= SPREAD_CONFIG.maxActivePositions) {
    return;
  }
  
  // Fetch markets based on configured type (15m, 5m, or all)
  const markets = await fetchCryptoMarkets({ type: SPREAD_CONFIG.marketType });
  
  for (const market of markets) {
    if (activePositions.has(market.conditionId)) continue;
    if (activePositions.size >= SPREAD_CONFIG.maxActivePositions) break;
    
    const timeRemaining = getTimeToSettlement(market);
    const minTime = SPREAD_CONFIG.marketType === "5m" 
      ? BOT_CONFIG.risk.panicTimeSec * 1.5 
      : BOT_CONFIG.risk.panicTimeSec * 3;
    if (timeRemaining < minTime) continue;
    
    // Subscribe to websocket for this market
    wsManager.subscribeMarket(market);
    
    // Wait a moment for initial orderbook data
    await sleep(500);
    
    const pos: SpreadPosition = {
      market,
      state: PositionState.IDLE,
      direction: "BID", // Will be set by placeSpreadOrders
      upOrderId: null,
      downOrderId: null,
      upPrice: 0,
      downPrice: 0,
      filledSide: null,
      filledPrice: 0,
      filledSize: 0,
      upInventory: 0,
      downInventory: 0,
      entryTime: new Date(),
      orderPlacedTime: null,
      realizedPnL: 0,
    };
    
    const success = await placeSpreadOrders(pos);
    if (success) {
      activePositions.set(market.conditionId, pos);
      log(`[${market.duration || "??"}] Started position: ${market.question.slice(0, 40)}...`);
    }
  }
}

async function mainLoop(): Promise<void> {
  let totalPnL = 0;
  
  // Initial market scan
  await scanForOpportunities();
  
  while (isRunning) {
    // Check for window transitions
    const window15mChanged = hasWindowChanged("15m");
    const window5mChanged = hasWindowChanged("5m");
    
    if (window15mChanged) {
      const windowStart = getCurrentWindowStart(15 * 60);
      log(`\n━━━ NEW 15-MIN WINDOW: ${formatWindowTime(windowStart)} ━━━`);
    }
    if (window5mChanged && SPREAD_CONFIG.marketType !== "15m") {
      const windowStart = getCurrentWindowStart(5 * 60);
      log(`\n━━━ NEW 5-MIN WINDOW: ${formatWindowTime(windowStart)} ━━━`);
    }
    
    // Process active positions
    for (const [conditionId, pos] of activePositions) {
      await processPosition(pos);
      
      if (pos.state === PositionState.CLOSED) {
        totalPnL += pos.realizedPnL;
        log(`Position closed. PnL: $${pos.realizedPnL.toFixed(4)} | Total: $${totalPnL.toFixed(4)}`);
        activePositions.delete(conditionId);
        
        // Unsubscribe from closed market
        wsManager.unsubscribeMarket(pos.market);
      }
    }
    
    // Look for new opportunities (especially after window change)
    if (window15mChanged || window5mChanged || activePositions.size < SPREAD_CONFIG.maxActivePositions) {
      await scanForOpportunities();
    }
    
    // Status update
    if (activePositions.size > 0) {
      log(`Active: ${activePositions.size} positions | Total PnL: $${totalPnL.toFixed(4)}`);
    } else {
      log(`Waiting for opportunities... (${SPREAD_CONFIG.marketType} markets)`);
    }
    
    await sleep(SPREAD_CONFIG.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Spread Trading Bot (WebSocket + Bid/Ask)");
  console.log("=".repeat(60));
  console.log("Config:");
  console.log(`  Market type:        ${SPREAD_CONFIG.marketType.toUpperCase()}`);
  console.log(`  Margin from mid:    ${(SPREAD_CONFIG.marginFromMid * 100).toFixed(1)}%`);
  console.log(`  Order size:         $${SPREAD_CONFIG.orderSizeUSD}`);
  console.log(`  Min spread:         ${(SPREAD_CONFIG.minSpreadToEnter * 100).toFixed(1)}%`);
  console.log(`  Time to expire:     ${SPREAD_CONFIG.timeToExpireSec}s`);
  console.log(`  Max loss:           ${(SPREAD_CONFIG.maxLossPct * 100).toFixed(1)}%`);
  console.log(`  Max positions:      ${SPREAD_CONFIG.maxActivePositions}`);
  console.log("Strategies:");
  console.log(`  BID side (buy <$1): ${SPREAD_CONFIG.enableBidSide ? "ENABLED" : "disabled"}`);
  console.log(`  ASK side (sell>$1): ${SPREAD_CONFIG.enableAskSide ? "ENABLED" : "disabled"}`);
  if (SPREAD_CONFIG.enableAskSide) {
    console.log(`  Pre-split for ASK:  $${SPREAD_CONFIG.preSplitUSD}`);
  }
  console.log("=".repeat(60));
  
  // Initialize CLOB client
  await initClient();
  
  // Initialize WebSocket connection
  log("Connecting to WebSocket...");
  await wsManager.connect();
  
  const wallet = await getWalletBalance();
  log(`Wallet: $${wallet.usdcBalance.toFixed(2)} USDC`);
  
  isRunning = true;
  
  process.on("SIGINT", async () => {
    log("Shutting down...");
    isRunning = false;
    
    // Cancel all orders and close positions
    for (const [_, pos] of activePositions) {
      if (pos.upOrderId) await cancelOrder(pos.upOrderId);
      if (pos.downOrderId) await cancelOrder(pos.downOrderId);
    }
    
    // Disconnect websocket
    wsManager.disconnect();
    
    log("Shutdown complete");
    process.exit(0);
  });
  
  await mainLoop();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
