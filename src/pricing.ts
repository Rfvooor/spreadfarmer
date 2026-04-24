import { getClient } from "./client.js";
import { BOT_CONFIG } from "./config.js";
import type { LadderLevel, MarketInfo } from "./types.js";

export async function getFairPrice(tokenId: string): Promise<number> {
  const client = getClient();
  const midpoint = await client.getMidpoint(tokenId);
  return parseFloat(midpoint.mid);
}

export async function getOrderbookPrices(tokenId: string): Promise<{ bid: number; ask: number; mid: number }> {
  const client = getClient();
  const book = await client.getOrderBook(tokenId);

  const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
  const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
  const mid = (bestBid + bestAsk) / 2;

  return { bid: bestBid, ask: bestAsk, mid };
}

/**
 * PRD §3.4: Calculate fee-equivalent using Polymarket's formula.
 * fee_equivalent = shares × price × 0.25 × (price × (1 − price))²
 */
export function calculateFeeEquivalent(shares: number, price: number): number {
  const p = Math.max(0.001, Math.min(0.999, price));
  return shares * p * 0.25 * Math.pow(p * (1 - p), 2);
}

/**
 * PRD §3.4: Calculate expected maker rebate.
 * 100% of taker fees redistributed during rebate periods.
 */
export function calculateExpectedRebate(shares: number, price: number, rebatePoolPercent: number = 1.0): number {
  return calculateFeeEquivalent(shares, price) * rebatePoolPercent;
}

/**
 * Get the effective fee rate at a given price (as percentage).
 * Peaks at 1.56% at price = 0.50
 */
export function getEffectiveFeeRate(price: number): number {
  const p = Math.max(0.001, Math.min(0.999, price));
  return 0.25 * Math.pow(p * (1 - p), 2) * 100;
}

/**
 * PRD §6.3: Calculate rebate weight for size allocation.
 * rawSize ∝ (p × (1 − p))²
 */
export function calculateRebateWeight(price: number): number {
  const p = Math.max(0.001, Math.min(0.999, price));
  return Math.pow(p * (1 - p), 2);
}

/**
 * PRD §7: Smart Profitability Filter.
 * expected_rebate + expected_spread − expected_loss > 0
 */
export function isQuoteEVPositive(
  fairPrice: number,
  quotePrice: number,
  sizeShares: number
): boolean {
  const { profitability } = BOT_CONFIG;
  
  const expectedRebate = calculateExpectedRebate(sizeShares, quotePrice, profitability.rebatePoolPercent);
  const expectedSpread = profitability.includeSpread ? sizeShares * (quotePrice - fairPrice) : 0;
  const expectedLoss = sizeShares * profitability.expectedLossPerShare;
  
  const netEV = expectedRebate + expectedSpread - expectedLoss;
  return netEV >= profitability.minEdgeUSD;
}

/**
 * Round price to valid tick size.
 * PRD §3.3: orderPriceMinTickSize = 0.001
 */
export function roundToTick(price: number, tickSize: number): number {
  const rounded = Math.round(price / tickSize) * tickSize;
  return Math.round(rounded * 1000) / 1000;
}

/**
 * PRD §6.1: Check if price is within allowed region.
 * allowedPrice ∈ [max(0.40, mid − maxSpread), min(0.60, mid + maxSpread)]
 */
export function isPriceInAllowedRegion(price: number, mid: number): boolean {
  const { risk, ladder } = BOT_CONFIG;
  const lower = Math.max(risk.allowedPriceMin, mid - ladder.maxSpread);
  const upper = Math.min(risk.allowedPriceMax, mid + ladder.maxSpread);
  return price >= lower && price <= upper;
}

/**
 * PRD §6.1: Get allowed price bounds for quoting.
 */
export function getAllowedPriceBounds(mid: number): { lower: number; upper: number } | null {
  const { risk, ladder } = BOT_CONFIG;
  
  // If mid is outside 40-60 band, no quoting allowed (PRD §8.3)
  if (mid < risk.allowedPriceMin || mid > risk.allowedPriceMax) {
    return null;
  }
  
  const lower = Math.max(risk.allowedPriceMin, mid - ladder.maxSpread);
  const upper = Math.min(risk.allowedPriceMax, mid + ladder.maxSpread);
  
  if (lower >= upper) {
    return null;
  }
  
  return { lower, upper };
}

/**
 * PRD §6: Build rebate-weighted ladder within allowed price region.
 * 
 * - Prices are symmetric around mid
 * - Sizes are rebate-weighted: rawSize ∝ (p × (1 − p))²
 * - Min order size = 5 shares (PRD §3.3)
 * - Outer levels must never exceed inner level size (PRD §6.3)
 */
export function buildLadder(
  fairPrice: number,
  totalShares: number,
  side: "UP" | "DOWN",
  market: MarketInfo,
  orderSide: "BUY" | "SELL" = "SELL"
): LadderLevel[] {
  const { ladder, minOrderSize } = BOT_CONFIG;
  const tickSize = parseFloat(market.tickSize);
  
  // For DOWN side, fair price is (1 - UP fair price)
  const sideFairPrice = side === "UP" ? fairPrice : (1 - fairPrice);
  
  // PRD §6.1: Get allowed price bounds
  const bounds = getAllowedPriceBounds(sideFairPrice);
  if (!bounds) {
    console.log(`[Pricing] ${side}: Fair price ${sideFairPrice.toFixed(3)} outside 40-60 band, skipping`);
    return [];
  }
  
  // Generate candidate price levels within allowed region
  const candidatePrices: number[] = [];
  const spacing = Math.max(ladder.minLevelSpacing, tickSize);
  
  console.log(`[Pricing] ${side} ladder: fair=${sideFairPrice.toFixed(3)}, spacing=${spacing}, tick=${tickSize}`);
  
  // For SELL: go above fair value, for BUY: go below fair value
  for (let i = 1; i <= ladder.levels; i++) {
    const offset = i * spacing;
    const price = orderSide === "SELL" 
      ? roundToTick(sideFairPrice + offset, tickSize)
      : roundToTick(sideFairPrice - offset, tickSize);
    
    if (price >= bounds.lower && price <= bounds.upper && price > 0 && price < 1) {
      candidatePrices.push(price);
    }
  }
  
  console.log(`[Pricing] ${side} candidates: ${candidatePrices.map(p => p.toFixed(3)).join(", ")}`)
  
  if (candidatePrices.length === 0) {
    console.log(`[Pricing] ${side}: No valid price levels in allowed region`);
    return [];
  }
  
  // PRD §6.3: Calculate rebate-weighted sizes
  const weights = candidatePrices.map(p => calculateRebateWeight(p));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  
  if (totalWeight === 0) {
    return [];
  }
  
  // Calculate raw sizes based on weights
  let rawSizes = weights.map(w => (w / totalWeight) * totalShares);
  
  // PRD §3.3: Enforce min order size = 5 shares
  // Drop levels that would be < 5 shares and redistribute
  let validLevels: { price: number; rawSize: number }[] = [];
  for (let i = 0; i < candidatePrices.length; i++) {
    if (rawSizes[i] >= minOrderSize) {
      validLevels.push({ price: candidatePrices[i], rawSize: rawSizes[i] });
    }
  }
  
  if (validLevels.length === 0) {
    // If no levels meet min size, try putting all shares at best price
    const bestPrice = candidatePrices[0];
    if (totalShares >= minOrderSize) {
      validLevels.push({ price: bestPrice, rawSize: totalShares });
    } else {
      console.log(`[Pricing] ${side}: Total shares ${totalShares} below min order size ${minOrderSize}`);
      return [];
    }
  }
  
  // Redistribute to valid levels
  const validTotalRaw = validLevels.reduce((a, b) => a + b.rawSize, 0);
  const redistributedSizes = validLevels.map(l => Math.floor((l.rawSize / validTotalRaw) * totalShares));
  
  // PRD §6.3: Ensure outer levels never exceed inner level size
  for (let i = 1; i < redistributedSizes.length; i++) {
    if (redistributedSizes[i] > redistributedSizes[i - 1]) {
      redistributedSizes[i] = redistributedSizes[i - 1];
    }
  }
  
  // Build final ladder levels with EV filter
  const levels: LadderLevel[] = [];
  
  for (let i = 0; i < validLevels.length; i++) {
    const price = validLevels[i].price;
    const sizeShares = redistributedSizes[i];
    
    // PRD §3.3: Skip if below min order size
    if (sizeShares < minOrderSize) {
      continue;
    }
    
    // PRD §7: Smart profitability filter
    if (!isQuoteEVPositive(sideFairPrice, price, sizeShares)) {
      console.log(`[Pricing] ${side} @ ${price.toFixed(3)}: EV not positive, skipping`);
      continue;
    }
    
    const expectedRebate = calculateExpectedRebate(sizeShares, price, BOT_CONFIG.profitability.rebatePoolPercent);
    
    levels.push({
      price,
      sizeShares,
      side,
      orderSide,
      expectedRebate,
    });
  }
  
  return levels;
}

export function calculateImbalance(upShares: number, downShares: number): number {
  const total = upShares + downShares;
  if (total === 0) return 0;
  return Math.abs(upShares - downShares) / total;
}

/**
 * Build paired bid orders for UP and DOWN that sum to < maxBidSum.
 * Returns the best bid prices that are +EV after rebates.
 * 
 * Example: If UP mid is 0.50, DOWN mid is 0.50, maxBidSum is 0.98:
 *   - Bid UP at 0.49, DOWN at 0.49 → sum = 0.98 ✓
 *   - If both fill, pay $0.98, receive tokens worth $1 at settlement
 */
export function buildBidPair(
  upMid: number,
  downMid: number,
  sizeShares: number,
  market: MarketInfo
): { upBid: LadderLevel | null; downBid: LadderLevel | null } {
  const { maxBidSum, minOrderSize, profitability } = BOT_CONFIG;
  const tickSize = parseFloat(market.tickSize);
  
  if (sizeShares < minOrderSize) {
    return { upBid: null, downBid: null };
  }
  
  // Start from mid and work down to find valid bid prices
  // that sum to < maxBidSum and are EV+
  let upBidPrice = roundToTick(upMid - tickSize, tickSize);
  let downBidPrice = roundToTick(downMid - tickSize, tickSize);
  
  // Adjust prices until sum is within limit
  while (upBidPrice + downBidPrice > maxBidSum && upBidPrice > 0.01 && downBidPrice > 0.01) {
    // Reduce the higher price first
    if (upBidPrice >= downBidPrice) {
      upBidPrice = roundToTick(upBidPrice - tickSize, tickSize);
    } else {
      downBidPrice = roundToTick(downBidPrice - tickSize, tickSize);
    }
  }
  
  const bidSum = upBidPrice + downBidPrice;
  
  // Check if sum is valid (< maxBidSum means we profit at settlement)
  if (bidSum >= maxBidSum) {
    console.log(`[Pricing] Bid sum ${bidSum.toFixed(3)} >= max ${maxBidSum}, skipping`);
    return { upBid: null, downBid: null };
  }
  
  // Calculate expected profit
  // Cost = upBidPrice + downBidPrice per share pair
  // Value at settlement = $1 per share (one side wins)
  const costPerPair = bidSum;
  const profitPerPair = 1 - costPerPair;
  
  // Add rebates
  const upRebate = calculateExpectedRebate(sizeShares, upBidPrice, profitability.rebatePoolPercent);
  const downRebate = calculateExpectedRebate(sizeShares, downBidPrice, profitability.rebatePoolPercent);
  const totalRebate = upRebate + downRebate;
  
  const totalEV = (profitPerPair * sizeShares) + totalRebate;
  
  console.log(`[Pricing] Bid pair: UP@${upBidPrice.toFixed(3)} + DOWN@${downBidPrice.toFixed(3)} = ${bidSum.toFixed(3)} | Profit: $${(profitPerPair * sizeShares).toFixed(3)} + Rebate: $${totalRebate.toFixed(4)}`);
  
  if (totalEV < profitability.minEdgeUSD) {
    console.log(`[Pricing] Bid pair EV $${totalEV.toFixed(4)} < min $${profitability.minEdgeUSD}, skipping`);
    return { upBid: null, downBid: null };
  }
  
  return {
    upBid: {
      price: upBidPrice,
      sizeShares,
      side: "UP",
      orderSide: "BUY",
      expectedRebate: upRebate,
    },
    downBid: {
      price: downBidPrice,
      sizeShares,
      side: "DOWN",
      orderSide: "BUY",
      expectedRebate: downRebate,
    },
  };
}

/**
 * Calculate available shares (not committed to open orders)
 */
export function getAvailableShares(
  totalShares: number,
  committedShares: number
): number {
  return Math.max(0, totalShares - committedShares);
}

/**
 * Calculate break-even price for remaining side after one side sold.
 * 
 * If we split $1 → 1 UP + 1 DOWN, and sold DOWN at 0.55:
 *   - We received $0.55
 *   - We need UP to sell for at least $0.45 to break even
 *   - Break-even = 1 - soldPrice = 0.45
 * 
 * For profit, we want: upPrice + downPrice > 1
 */
export function calculateBreakEvenPrice(
  soldPrice: number,
  targetProfit: number = 0
): number {
  // breakEven = 1 - soldPrice + targetProfit
  return Math.max(0.001, 1 - soldPrice + targetProfit);
}

/**
 * Calculate minimum profitable exit price for imbalanced inventory.
 * 
 * @param sharesSold - shares of one side already sold
 * @param avgSoldPrice - weighted avg price of sold shares
 * @param remainingShares - shares of opposite side still held
 * @param costBasis - original cost (typically $1 per pair)
 */
export function calculateMinExitPrice(
  sharesSold: number,
  avgSoldPrice: number,
  remainingShares: number,
  costBasis: number = 1
): number {
  if (remainingShares <= 0) return 0;
  
  const proceeds = sharesSold * avgSoldPrice;
  const neededFromRemaining = (sharesSold * costBasis) - proceeds;
  const minPrice = neededFromRemaining / remainingShares;
  
  // Ensure it's a valid price
  return Math.max(0.001, Math.min(0.999, minPrice));
}

/**
 * Estimate total PnL including proceeds from sold shares.
 * 
 * Total PnL = (remaining market value) + (proceeds from sales) - (original cost)
 * 
 * Example: Split $15 → 15 UP + 15 DOWN, sold 15 DOWN @ $0.50
 *   marketValue = 15 UP * $0.50 = $7.50
 *   proceeds = 15 DOWN * $0.50 = $7.50
 *   cost = $15
 *   PnL = $7.50 + $7.50 - $15 = $0
 */
export function estimateUnrealizedPnL(
  position: { 
    upShares: number; 
    downShares: number; 
    costBasisUSD: number;
    upSharesSold?: number;
    upFillPrice?: number;
    downSharesSold?: number;
    downFillPrice?: number;
  },
  upPrice: number,
  downPrice: number
): number {
  const marketValue = position.upShares * upPrice + position.downShares * downPrice;
  
  // Add proceeds from already sold shares
  const upProceeds = (position.upSharesSold || 0) * (position.upFillPrice || 0);
  const downProceeds = (position.downSharesSold || 0) * (position.downFillPrice || 0);
  const totalProceeds = upProceeds + downProceeds;
  
  return marketValue + totalProceeds - position.costBasisUSD;
}
