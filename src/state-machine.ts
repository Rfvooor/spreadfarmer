import { BOT_CONFIG } from "./config.js";
import { 
  buildLadder, 
  buildBidPair,
  calculateImbalance, 
  calculateExpectedRebate, 
  estimateUnrealizedPnL, 
  getFairPrice, 
  getOrderbookPrices,
  getAllowedPriceBounds,
  getAvailableShares
} from "./pricing.js";
import { cancelOrdersForMarket, marketSell, postLadderOrders, postBothLadders } from "./orders.js";
import { getTimeToSettlement } from "./markets.js";
import { splitPosition, mergePositions } from "./split-merge.js";
import { BotState, type MarketCycle, type MarketInfo, type Position, type FarmingMode } from "./types.js";
import { getPositionsForMarket, getTradesForMarket } from "./wallet.js";

const POSITION_SYNC_INTERVAL_MS = 10000; // Sync on-chain positions every 10s

/**
 * Recalculate min exit prices based on total cost basis and proceeds.
 * 
 * Break-even formula:
 *   totalProceeds >= costBasisUSD
 *   (upProceeds + downProceeds + remainingValue) >= costBasisUSD
 * 
 * For remaining UP only:
 *   upShares * minPrice >= costBasisUSD - upProceeds - downProceeds
 *   minPrice = (costBasisUSD - totalProceeds) / upShares
 * 
 * Example: Split $28 → 28 UP + 28 DOWN, sold 28 DOWN @ $0.693
 *   downProceeds = $19.40
 *   needed = $28 - $19.40 = $8.60
 *   minUpPrice = $8.60 / 28 = $0.307
 */
export function updateMinExitPrices(position: import("./types.js").Position): void {
  const upProceeds = (position.upSharesSold || 0) * (position.upFillPrice || 0);
  const downProceeds = (position.downSharesSold || 0) * (position.downFillPrice || 0);
  const totalProceeds = upProceeds + downProceeds;
  const stillNeeded = position.costBasisUSD - totalProceeds;
  
  // Debug: log the calculation inputs
  if (position.upSharesSold > 0 || position.downSharesSold > 0) {
    console.log(`[MinExit] Cost: $${position.costBasisUSD.toFixed(2)}, Proceeds: $${totalProceeds.toFixed(2)} (UP: ${position.upSharesSold}@${position.upFillPrice.toFixed(3)}, DOWN: ${position.downSharesSold}@${position.downFillPrice.toFixed(3)}), StillNeeded: $${stillNeeded.toFixed(2)}`);
  }
  
  // If already in profit (stillNeeded <= 0), no min price needed
  if (stillNeeded <= 0) {
    position.minUpExitPrice = 0;
    position.minDownExitPrice = 0;
    return;
  }
  
  // Calculate min exit prices based on which side was sold
  // If one side was sold, the other side needs to cover the remaining cost
  
  // UP was sold → need to sell DOWN to break even
  if (position.upSharesSold > 0 && position.downShares > 0) {
    // All remaining value must come from DOWN
    position.minDownExitPrice = Math.min(0.99, stillNeeded / position.downShares);
  } else {
    position.minDownExitPrice = 0;
  }
  
  // DOWN was sold → need to sell UP to break even
  if (position.downSharesSold > 0 && position.upShares > 0) {
    // All remaining value must come from UP
    position.minUpExitPrice = Math.min(0.99, stillNeeded / position.upShares);
  } else {
    position.minUpExitPrice = 0;
  }
}

export function createMarketCycle(marketInfo: MarketInfo, capitalUSD: number, mode: FarmingMode = BOT_CONFIG.farmingMode): MarketCycle {
  const shares = Math.floor(capitalUSD / 1);
  return {
    marketInfo,
    state: BotState.IDLE,
    position: {
      upShares: mode === "sell" ? shares : 0, // For bid mode, we don't have tokens yet
      downShares: mode === "sell" ? shares : 0,
      costBasisUSD: capitalUSD,
      upSharesCommitted: 0,
      downSharesCommitted: 0,
      upFillPrice: 0,
      downFillPrice: 0,
      upSharesSold: 0,
      downSharesSold: 0,
      minUpExitPrice: 0,
      minDownExitPrice: 0,
    },
    activeOrders: new Map(),
    upLadder: [],
    downLadder: [],
    startTime: new Date(),
    lastFairPrice: 0.5,
    pnlRealized: 0,
    pnlUnrealized: 0,
    mode,
    imbalanceDetectedAt: null,
    lastPositionSync: Date.now(),
  };
}

/**
 * Sync internal position state with on-chain balances.
 * Call periodically to prevent desync issues.
 */
export async function syncPositionState(cycle: MarketCycle): Promise<boolean> {
  const { marketInfo, position } = cycle;
  const now = Date.now();
  
  // Only sync every POSITION_SYNC_INTERVAL_MS
  if (now - cycle.lastPositionSync < POSITION_SYNC_INTERVAL_MS) {
    return false;
  }
  
  try {
    const onChain = await getPositionsForMarket(marketInfo.upTokenId, marketInfo.downTokenId);
    
    const upDiff = Math.abs(onChain.upShares - position.upShares);
    const downDiff = Math.abs(onChain.downShares - position.downShares);
    
    // If significant difference, update internal state
    if (upDiff > 0.5 || downDiff > 0.5) {
      // Detect if shares decreased (likely a fill we missed)
      const upSold = position.upShares - onChain.upShares;
      const downSold = position.downShares - onChain.downShares;
      
      console.log(`[PositionSync] Updating: UP ${position.upShares.toFixed(2)} → ${onChain.upShares.toFixed(2)}, DOWN ${position.downShares.toFixed(2)} → ${onChain.downShares.toFixed(2)}`);
      
      // Fetch recent trades to get actual fill prices
      const { upTrades, downTrades } = await getTradesForMarket(
        marketInfo.upTokenId,
        marketInfo.downTokenId,
        10
      );
      
      // If we detected sales, update sold tracking using actual trade prices
      // Use position diff as authoritative sold amount, trades API just for price
      if (upSold > 0.5) {
        // Find recent SELL trades for UP to get fill price
        const recentUpSells = upTrades.filter(t => t.side === "SELL");
        let fillPrice = cycle.lastFairPrice; // fallback
        
        if (recentUpSells.length > 0) {
          // Use weighted avg of recent sells for price only
          let totalValue = 0;
          let totalSize = 0;
          for (const trade of recentUpSells) {
            totalValue += trade.size * trade.price;
            totalSize += trade.size;
          }
          if (totalSize > 0) {
            fillPrice = totalValue / totalSize;
          }
        }
        
        // Use position diff as the sold amount (authoritative)
        const prevTotal = position.upSharesSold * position.upFillPrice;
        position.upSharesSold += upSold;
        position.upFillPrice = (prevTotal + upSold * fillPrice) / position.upSharesSold;
        console.log(`[PositionSync] Detected UP sale: ${upSold.toFixed(2)} @ ${fillPrice.toFixed(3)}`);
      }
      
      if (downSold > 0.5) {
        // Find recent SELL trades for DOWN to get fill price
        const recentDownSells = downTrades.filter(t => t.side === "SELL");
        let fillPrice = 1 - cycle.lastFairPrice; // fallback
        
        if (recentDownSells.length > 0) {
          let totalValue = 0;
          let totalSize = 0;
          for (const trade of recentDownSells) {
            totalValue += trade.size * trade.price;
            totalSize += trade.size;
          }
          if (totalSize > 0) {
            fillPrice = totalValue / totalSize;
          }
        }
        
        // Use position diff as the sold amount (authoritative)
        const prevTotal = position.downSharesSold * position.downFillPrice;
        position.downSharesSold += downSold;
        position.downFillPrice = (prevTotal + downSold * fillPrice) / position.downSharesSold;
        console.log(`[PositionSync] Detected DOWN sale: ${downSold.toFixed(2)} @ ${fillPrice.toFixed(3)}`);
      }
      
      // Update current holdings
      position.upShares = onChain.upShares;
      position.downShares = onChain.downShares;
      
      // Reset committed shares since we don't know order state
      position.upSharesCommitted = 0;
      position.downSharesCommitted = 0;
      
      // Recalculate min exit prices based on updated sold tracking
      updateMinExitPrices(position);
      
      if (position.minUpExitPrice > 0 || position.minDownExitPrice > 0) {
        console.log(`[PositionSync] Min exit prices: UP >= ${position.minUpExitPrice.toFixed(3)}, DOWN >= ${position.minDownExitPrice.toFixed(3)}`);
      }
      
      cycle.lastPositionSync = now;
      return true;
    }
    
    cycle.lastPositionSync = now;
    return false;
  } catch (err) {
    console.error("[PositionSync] Failed to sync:", err);
    return false;
  }
}

/**
 * PRD §10: State Machine transitions.
 * States: IDLE → SPLIT → QUOTING → PARTIAL_FILL/IMBALANCED → EXITING → HALTED
 */
export async function transitionState(cycle: MarketCycle): Promise<BotState> {
  const timeRemaining = getTimeToSettlement(cycle.marketInfo);
  const { risk, timeDecay } = BOT_CONFIG;

  console.log(`[StateMachine] ${cycle.state} | Time remaining: ${Math.floor(timeRemaining)}s`);

  switch (cycle.state) {
    case BotState.IDLE:
      // Check if market already expired
      if (timeRemaining <= 0) {
        console.log("[StateMachine] Market already expired, halting");
        return BotState.HALTED;
      }
      // For bid mode, skip split and go directly to quoting
      if (cycle.mode === "bid") {
        return BotState.QUOTING;
      }
      return BotState.SPLIT;

    case BotState.SPLIT:
      // Check if market expired during split
      if (timeRemaining <= 0) {
        console.log("[StateMachine] Market expired during split, halting");
        return BotState.HALTED;
      }
      console.log(`[StateMachine] Split complete: ${cycle.position.upShares} UP + ${cycle.position.downShares} DOWN`);
      return BotState.QUOTING;

    case BotState.QUOTING: {
      // PRD §9: <60s remaining → force flatten (EXITING)
      if (timeRemaining < timeDecay.forceResolutionSec) {
        console.log("[StateMachine] <60s remaining, forcing exit");
        return BotState.EXITING;
      }

      // PRD §9: <120s remaining → stop new orders, transition to EXITING
      if (timeRemaining < timeDecay.stopNewQuotesSec) {
        console.log("[StateMachine] <120s remaining, stopping new orders");
        return BotState.EXITING;
      }

      // PRD §8.3: Check if price exits allowed band
      const fairPrice = await getFairPrice(cycle.marketInfo.upTokenId);
      const isOutOfBand = fairPrice < risk.allowedPriceMin || fairPrice > risk.allowedPriceMax;
      const hasInventory = cycle.position.upShares > 0 || cycle.position.downShares > 0;
      
      if (isOutOfBand) {
        if (!hasInventory) {
          console.log(`[StateMachine] Price ${fairPrice.toFixed(3)} outside band, no inventory, halting`);
          return BotState.HALTED;
        }
        
        // Price outside band - just wait for recovery, don't sell yet
        console.log(`[StateMachine] Price ${fairPrice.toFixed(3)} outside band, waiting (${Math.floor(timeRemaining)}s left)`);
        return BotState.QUOTING; // Stay in quoting but won't place orders
      }

      // PRD §8.3: Check imbalance
      const imbalance = calculateImbalance(cycle.position.upShares, cycle.position.downShares);
      
      if (imbalance > risk.largeImbalanceThreshold) {
        console.log(`[StateMachine] Large imbalance: ${(imbalance * 100).toFixed(1)}%`);
        // PRD §8.3: Large imbalance, <2 min → market close
        if (timeRemaining < 120) {
          return BotState.EXITING;
        }
        // PRD §8.3: Large imbalance, >5 min → aggressive exit quoting
        return BotState.IMBALANCED;
      }
      
      if (imbalance > risk.smallImbalanceThreshold) {
        console.log(`[StateMachine] Small imbalance: ${(imbalance * 100).toFixed(1)}%`);
        // PRD §8.3: Small imbalance, <2 min → market close
        if (timeRemaining < 120) {
          return BotState.EXITING;
        }
        // PRD §8.3: Small imbalance, >5 min → hold + re-quote tighter (stay in QUOTING)
        // Will use tighter spreads in executeStateActions
      }

      return BotState.QUOTING;
    }

    case BotState.PARTIAL_FILL: {
      // Time expired - force halt
      if (timeRemaining <= 0) {
        console.log("[StateMachine] Market expired during partial fill");
        return BotState.HALTED;
      }
      
      // Check if we've recovered balance
      const imbalance = calculateImbalance(cycle.position.upShares, cycle.position.downShares);
      
      if (imbalance < risk.smallImbalanceThreshold) {
        console.log("[StateMachine] Recovered from partial fill, resuming quoting");
        return BotState.QUOTING;
      }
      
      if (timeRemaining < timeDecay.forceResolutionSec) {
        return BotState.EXITING;
      }
      
      return BotState.PARTIAL_FILL;
    }

    case BotState.IMBALANCED: {
      const prices = await getOrderbookPrices(cycle.marketInfo.upTokenId);
      const unrealizedLoss = -estimateUnrealizedPnL(
        cycle.position,
        prices.mid,
        1 - prices.mid
      );

      // PRD §13: Max loss circuit breaker
      if (unrealizedLoss > risk.maxUnrealizedLossUSD) {
        console.log(`[StateMachine] Max loss exceeded: $${unrealizedLoss.toFixed(2)}`);
        return BotState.EXITING;
      }

      // PRD §9: Time-based transitions - near resolution supersedes all
      if (timeRemaining < timeDecay.forceResolutionSec) {
        console.log(`[StateMachine] Near resolution (${Math.floor(timeRemaining)}s), forcing exit`);
        return BotState.EXITING;
      }

      // PRD §8.3: Any imbalance, <2 min → market close
      if (timeRemaining < 120) {
        console.log(`[StateMachine] <2min remaining with imbalance, forcing exit`);
        return BotState.EXITING;
      }

      // Check if recovered
      const imbalance = calculateImbalance(cycle.position.upShares, cycle.position.downShares);
      if (imbalance < risk.smallImbalanceThreshold) {
        console.log("[StateMachine] Imbalance recovered, resuming quoting");
        cycle.imbalanceDetectedAt = null; // Reset hold timer
        return BotState.QUOTING;
      }

      // Stop loss check: if unrealized loss exceeds threshold, force exit
      const costBasis = cycle.position.costBasisUSD;
      const stopLossUSD = costBasis * risk.imbalanceStopLossPct;
      if (unrealizedLoss > stopLossUSD) {
        console.log(`[StateMachine] Stop loss triggered: $${unrealizedLoss.toFixed(2)} > ${(risk.imbalanceStopLossPct * 100).toFixed(0)}% ($${stopLossUSD.toFixed(2)})`);
        return BotState.EXITING;
      }

      return BotState.IMBALANCED;
    }

    case BotState.EXITING:
      // Exit complete when no inventory
      if (cycle.position.upShares === 0 && cycle.position.downShares === 0) {
        return BotState.HALTED;
      }
      
      // Time's up
      if (timeRemaining <= 0) {
        return BotState.HALTED;
      }

      return BotState.EXITING;

    case BotState.HALTED:
      return BotState.HALTED;

    default:
      return BotState.IDLE;
  }
}

export async function executeStateActions(cycle: MarketCycle): Promise<void> {
  const { marketInfo, position } = cycle;
  const timeRemaining = getTimeToSettlement(marketInfo);
  const { risk, timeDecay } = BOT_CONFIG;

  // Periodically sync position state with on-chain balances to prevent desync
  const didSync = await syncPositionState(cycle);
  if (didSync) {
    // If we synced and state changed significantly, cancel stale orders
    await cancelOrdersForMarket(marketInfo.conditionId);
    cycle.activeOrders.clear();
  }

  switch (cycle.state) {
    case BotState.SPLIT:
      try {
        // Check for existing positions first
        const existing = await getPositionsForMarket(marketInfo.upTokenId, marketInfo.downTokenId);
        
        if (existing.upShares > 0 || existing.downShares > 0) {
          console.log(`[StateActions] Found existing position: ${existing.upShares.toFixed(2)} UP + ${existing.downShares.toFixed(2)} DOWN`);
          cycle.position.upShares = existing.upShares;
          cycle.position.downShares = existing.downShares;
          cycle.position.costBasisUSD = Math.min(existing.upShares, existing.downShares);
          // Reset tracking for existing positions
          cycle.position.upSharesCommitted = 0;
          cycle.position.downSharesCommitted = 0;
          cycle.position.upFillPrice = 0;
          cycle.position.downFillPrice = 0;
          cycle.position.upSharesSold = 0;
          cycle.position.downSharesSold = 0;
        } else {
          // Before splitting new capital, check market conditions
          // 1. Check time remaining - don't split if near resolution
          if (timeRemaining < timeDecay.stopNewQuotesSec) {
            console.log(`[StateActions] Too close to resolution (${Math.floor(timeRemaining)}s), skipping split`);
            cycle.state = BotState.HALTED;
            return;
          }
          
          // 2. Check price is in allowed band
          const fairPrice = await getFairPrice(marketInfo.upTokenId);
          const bounds = getAllowedPriceBounds(fairPrice);
          if (!bounds) {
            console.log(`[StateActions] Price ${fairPrice.toFixed(3)} outside allowed band, skipping split`);
            cycle.state = BotState.HALTED;
            return;
          }
          
          console.log(`[StateActions] Pre-split checks passed: ${Math.floor(timeRemaining)}s remaining, price ${fairPrice.toFixed(3)} in band`);
          
          // Split new capital
          const capitalToSplit = cycle.position.costBasisUSD;
          console.log(`[StateActions] Splitting $${capitalToSplit} USDC into UP/DOWN tokens...`);
          
          const { upTokens, downTokens } = await splitPosition(marketInfo, capitalToSplit);
          cycle.position.upShares = upTokens;
          cycle.position.downShares = downTokens;
          
          console.log(`[StateActions] Split complete: ${upTokens} UP + ${downTokens} DOWN tokens`);
        }
      } catch (err) {
        console.error("[StateActions] Split failed:", err);
        cycle.state = BotState.HALTED;
      }
      break;

    case BotState.QUOTING:
      try {
        const fairPrice = await getFairPrice(marketInfo.upTokenId);
        const downMid = 1 - fairPrice;

        // PRD §8.3: Check if in allowed band - if not, transition to EXITING (handled by transitionState)
        const bounds = getAllowedPriceBounds(fairPrice);
        if (!bounds) {
          console.log(`[StateActions] Fair price ${fairPrice.toFixed(3)} outside allowed region, will exit`);
          // Don't set state here - let transitionState handle it on next tick
          return;
        }
        
        // First time quoting - set initial price and post orders
        const isFirstQuote = cycle.upLadder.length === 0 && cycle.downLadder.length === 0;
        
        // PRD §6.2: Recenter when mid moves >0.002
        const shouldRecenter = !isFirstQuote && Math.abs(fairPrice - cycle.lastFairPrice) > BOT_CONFIG.recenterThreshold;
        
        if (isFirstQuote || shouldRecenter) {
          if (shouldRecenter) {
            console.log(`[StateActions] Recentering: price moved ${cycle.lastFairPrice.toFixed(3)} -> ${fairPrice.toFixed(3)}`);
            // Cancel existing orders
            await cancelOrdersForMarket(marketInfo.conditionId);
            cycle.activeOrders.clear();
            position.upSharesCommitted = 0;
            position.downSharesCommitted = 0;
          }
          
          cycle.lastFairPrice = fairPrice;

          if (cycle.mode === "bid") {
            // BID MODE: Place buy orders on both sides that sum to < $1
            const sizeShares = Math.floor(position.costBasisUSD);
            
            console.log(`[StateActions] BID MODE: Placing buy orders for ${sizeShares} shares`);
            
            const { upBid, downBid } = buildBidPair(fairPrice, downMid, sizeShares, marketInfo);
            
            if (upBid && downBid) {
              cycle.upLadder = [upBid];
              cycle.downLadder = [downBid];
              
              const upOrders = await postLadderOrders(cycle.upLadder, marketInfo.upTokenId, marketInfo);
              for (const order of upOrders) {
                cycle.activeOrders.set(order.orderId, order);
              }
              
              const downOrders = await postLadderOrders(cycle.downLadder, marketInfo.downTokenId, marketInfo);
              for (const order of downOrders) {
                cycle.activeOrders.set(order.orderId, order);
              }
            }
          } else {
            // SELL MODE: Split tokens and sell them
            // PRD §8.3: Tighter quotes if small imbalance
            const imbalance = calculateImbalance(position.upShares, position.downShares);
            let sizeMultiplier = 1.0;
            
            if (imbalance > risk.smallImbalanceThreshold) {
              sizeMultiplier = 0.7;
            }
            
            if (timeRemaining < timeDecay.reducedSizeMin * 60) {
              sizeMultiplier = 0.5;
            }

            // Calculate available shares (total - already committed)
            const availableUp = getAvailableShares(position.upShares, position.upSharesCommitted);
            const availableDown = getAvailableShares(position.downShares, position.downSharesCommitted);
            
            console.log(`[StateActions] SELL MODE: UP ${position.upShares} (${availableUp} avail), DOWN ${position.downShares} (${availableDown} avail)`);

            // Build both ladders
            if (availableUp >= BOT_CONFIG.minOrderSize) {
              cycle.upLadder = buildLadder(fairPrice, availableUp * sizeMultiplier, "UP", marketInfo, "SELL");
            }
            if (availableDown >= BOT_CONFIG.minOrderSize) {
              cycle.downLadder = buildLadder(fairPrice, availableDown * sizeMultiplier, "DOWN", marketInfo, "SELL");
            }

            // Batch post both ladders together (more efficient)
            if (cycle.upLadder.length > 0 && cycle.downLadder.length > 0) {
              const { upOrders, downOrders } = await postBothLadders(
                cycle.upLadder,
                cycle.downLadder,
                marketInfo.upTokenId,
                marketInfo.downTokenId,
                marketInfo
              );
              
              for (const order of upOrders) {
                cycle.activeOrders.set(order.orderId, order);
                position.upSharesCommitted += order.size;
              }
              for (const order of downOrders) {
                cycle.activeOrders.set(order.orderId, order);
                position.downSharesCommitted += order.size;
              }
            }
          }
        }
      } catch (err) {
        console.error("[StateActions] Quoting error:", err);
      }
      break;

    case BotState.PARTIAL_FILL:
      // Similar to QUOTING but monitor more closely
      try {
        await cancelOrdersForMarket(marketInfo.conditionId);
        cycle.activeOrders.clear();

        const fairPrice = await getFairPrice(marketInfo.upTokenId);
        cycle.lastFairPrice = fairPrice;

        // Quote only the side we have more of to rebalance
        if (position.upShares > position.downShares && position.upShares >= BOT_CONFIG.minOrderSize) {
          cycle.upLadder = buildLadder(fairPrice, position.upShares, "UP", marketInfo);
          const orders = await postLadderOrders(cycle.upLadder, marketInfo.upTokenId, marketInfo);
          for (const order of orders) {
            cycle.activeOrders.set(order.orderId, order);
          }
        } else if (position.downShares >= BOT_CONFIG.minOrderSize) {
          cycle.downLadder = buildLadder(fairPrice, position.downShares, "DOWN", marketInfo);
          const orders = await postLadderOrders(cycle.downLadder, marketInfo.downTokenId, marketInfo);
          for (const order of orders) {
            cycle.activeOrders.set(order.orderId, order);
          }
        }
      } catch (err) {
        console.error("[StateActions] Partial fill handling error:", err);
      }
      break;

    case BotState.IMBALANCED:
      try {
        const { risk } = BOT_CONFIG;
        const now = Date.now();
        
        // Track when imbalance started (first time entering)
        const isFirstEntry = cycle.imbalanceDetectedAt === null;
        if (isFirstEntry) {
          cycle.imbalanceDetectedAt = now;
          console.log(`[IMBALANCED] Imbalance detected, holding for ${risk.imbalanceHoldMs}ms before quoting`);
          
          // Force position sync on first entry to get actual trade data
          cycle.lastPositionSync = 0;
          await syncPositionState(cycle);
          
          // Cancel any stale orders from previous state
          await cancelOrdersForMarket(marketInfo.conditionId);
          cycle.activeOrders.clear();
          position.upSharesCommitted = 0;
          position.downSharesCommitted = 0;
        }
        
        // Check if we should wait (hold period not elapsed)
        const holdElapsed = now - (cycle.imbalanceDetectedAt ?? now);
        const shouldHold = holdElapsed < risk.imbalanceHoldMs;
        
        const fairPrice = await getFairPrice(marketInfo.upTokenId);
        cycle.lastFairPrice = fairPrice;
        
        // Ensure min exit prices are up to date
        updateMinExitPrices(position);
        
        // If still in hold period and not near resolution, wait for price recovery
        if (shouldHold && timeRemaining > 120) {
          const holdRemaining = Math.ceil((risk.imbalanceHoldMs - holdElapsed) / 1000);
          const upProceeds = position.upSharesSold * position.upFillPrice;
          const downProceeds = position.downSharesSold * position.downFillPrice;
          const stillNeeded = position.costBasisUSD - upProceeds - downProceeds;
          const profitStatus = stillNeeded < 0 ? `PROFIT $${(-stillNeeded).toFixed(2)}` : `need $${stillNeeded.toFixed(2)}`;
          console.log(`[IMBALANCED] Holding ${holdRemaining}s | UP: ${position.upShares.toFixed(1)} remain, DOWN: ${position.downShares.toFixed(1)} remain | ${profitStatus}`);
          return; // Don't place orders yet, wait for price to recover
        }
        
        // If we already have exit orders placed, don't recenter - let them fill
        if (cycle.activeOrders.size > 0) {
          console.log(`[IMBALANCED] Exit orders active (${cycle.activeOrders.size}), waiting for fills...`);
          return;
        }
        
        console.log(`[IMBALANCED] Placing exit orders (fair=${fairPrice.toFixed(3)})`);
        
        // Determine which side needs to be sold and use pre-computed min exit prices
        if (position.upShares > position.downShares && position.upShares >= BOT_CONFIG.minOrderSize) {
          // More UP than DOWN - need to sell UP
          console.log(`[IMBALANCED] DOWN sold ${position.downSharesSold} @ ${position.downFillPrice.toFixed(3)} → UP min exit: ${position.minUpExitPrice.toFixed(3)}`);
          
          // Quote UP at or above break-even (never below)
          const targetPrice = Math.max(position.minUpExitPrice, fairPrice);
          const availableUp = getAvailableShares(position.upShares, position.upSharesCommitted);
          
          if (availableUp >= BOT_CONFIG.minOrderSize) {
            // Use targetPrice as fair price so ladder is built above it
            const ladder = buildLadder(targetPrice, availableUp, "UP", marketInfo);
            const orders = await postLadderOrders(ladder, marketInfo.upTokenId, marketInfo);
            for (const order of orders) {
              cycle.activeOrders.set(order.orderId, order);
              position.upSharesCommitted += order.size;
            }
          }
        } else if (position.downShares > position.upShares && position.downShares >= BOT_CONFIG.minOrderSize) {
          // More DOWN than UP - need to sell DOWN
          console.log(`[IMBALANCED] UP sold ${position.upSharesSold} @ ${position.upFillPrice.toFixed(3)} → DOWN min exit: ${position.minDownExitPrice.toFixed(3)}`);
          
          // Quote DOWN at or above break-even
          const targetPrice = Math.max(position.minDownExitPrice, 1 - fairPrice);
          const availableDown = getAvailableShares(position.downShares, position.downSharesCommitted);
          
          if (availableDown >= BOT_CONFIG.minOrderSize) {
            // For DOWN, fair price is (1 - UP fair), so pass 1 - targetPrice
            const ladder = buildLadder(1 - targetPrice, availableDown, "DOWN", marketInfo);
            const orders = await postLadderOrders(ladder, marketInfo.downTokenId, marketInfo);
            for (const order of orders) {
              cycle.activeOrders.set(order.orderId, order);
              position.downSharesCommitted += order.size;
            }
          }
        }
      } catch (err) {
        console.error("[StateActions] Imbalanced handling error:", err);
      }
      break;

    case BotState.EXITING:
      try {
        // PRD §9: Force inventory flattening
        await cancelOrdersForMarket(marketInfo.conditionId);
        cycle.activeOrders.clear();
        position.upSharesCommitted = 0;
        position.downSharesCommitted = 0;

        // ALWAYS prefer merge over sell - merge recovers $1, selling at extreme prices loses money
        const mergeableAmount = Math.min(position.upShares, position.downShares);
        if (mergeableAmount >= 1) {
          try {
            console.log(`[StateActions] Merging ${mergeableAmount.toFixed(2)} balanced pairs back to USDC`);
            await mergePositions(marketInfo, mergeableAmount);
            position.upShares -= mergeableAmount;
            position.downShares -= mergeableAmount;
            cycle.pnlRealized += mergeableAmount; // Recovered full $1 per pair
            console.log(`[StateActions] Merged ${mergeableAmount.toFixed(2)} pairs, recovered $${mergeableAmount.toFixed(2)}`);
          } catch (err) {
            console.error("[StateActions] Merge failed:", err);
          }
        }

        // Only sell remaining IMBALANCED inventory (after merge)
        // This is inventory that couldn't be merged (one side has more than the other)
        if (timeRemaining > 5) {
          if (position.upShares >= BOT_CONFIG.minOrderSize) {
            const fairPrice = cycle.lastFairPrice;
            console.log(`[StateActions] Selling excess ${position.upShares.toFixed(2)} UP shares`);
            const sold = await marketSell(marketInfo.upTokenId, position.upShares, marketInfo);
            if (sold) {
              cycle.position.upShares = 0;
            }
          }

          if (position.downShares >= BOT_CONFIG.minOrderSize) {
            console.log(`[StateActions] Selling excess ${position.downShares.toFixed(2)} DOWN shares`);
            const sold = await marketSell(marketInfo.downTokenId, position.downShares, marketInfo);
            if (sold) {
              cycle.position.downShares = 0;
            }
          }
        }

        // If time expired and we still have inventory, zero it out (will be redeemed after settlement)
        if (timeRemaining <= 0) {
          if (position.upShares > 0 || position.downShares > 0) {
            console.log(`[StateActions] Market expired with ${position.upShares} UP, ${position.downShares} DOWN - redeem after settlement`);
          }
          cycle.position.upShares = 0;
          cycle.position.downShares = 0;
        }
      } catch (err) {
        console.error("[StateActions] Exiting error:", err);
      }
      break;

    case BotState.HALTED:
      // If we have balanced inventory, merge it back to USDC
      const haltMergeAmount = Math.min(position.upShares, position.downShares);
      if (haltMergeAmount >= 1) {
        try {
          console.log(`[StateActions] Merging ${haltMergeAmount.toFixed(2)} balanced pairs before halt`);
          await mergePositions(marketInfo, haltMergeAmount);
          position.upShares -= haltMergeAmount;
          position.downShares -= haltMergeAmount;
          cycle.pnlRealized += haltMergeAmount;
          console.log(`[StateActions] Merged, recovered $${haltMergeAmount.toFixed(2)}`);
        } catch (err) {
          console.error("[StateActions] Merge on halt failed:", err);
        }
      }
      console.log(`[StateActions] Market cycle halted. PnL Realized: $${cycle.pnlRealized.toFixed(2)}`);
      break;
  }
}

export async function handleFillEvent(
  cycle: MarketCycle,
  orderId: string,
  filledSize: number,
  filledPrice: number
): Promise<void> {
  const order = cycle.activeOrders.get(orderId);
  if (!order) return;

  const { position } = cycle;
  const cost = filledSize * filledPrice;
  const rebate = calculateExpectedRebate(filledSize, filledPrice, BOT_CONFIG.profitability.rebatePoolPercent);
  
  const isUp = order.tokenId === cycle.marketInfo.upTokenId;
  const side = isUp ? "UP" : "DOWN";

  if (order.side === "BUY") {
    // BID MODE: Buying tokens
    if (isUp) {
      position.upShares += filledSize;
      position.upSharesCommitted = Math.max(0, position.upSharesCommitted - filledSize);
      // Track weighted average buy price
      const prevTotal = position.upSharesSold * position.upFillPrice;
      position.upSharesSold += filledSize;
      position.upFillPrice = (prevTotal + cost) / position.upSharesSold;
    } else {
      position.downShares += filledSize;
      position.downSharesCommitted = Math.max(0, position.downSharesCommitted - filledSize);
      const prevTotal = position.downSharesSold * position.downFillPrice;
      position.downSharesSold += filledSize;
      position.downFillPrice = (prevTotal + cost) / position.downSharesSold;
    }
    
    // For bid mode, profit is realized at settlement, estimate based on expected $1 payout
    // Expected value = $1 * P(win) - cost + rebate
    // Since we buy both sides, when both fill: value = $1, cost = upPrice + downPrice
    const expectedProfit = rebate; // Just count rebate for now, settlement profit later
    cycle.pnlRealized += expectedProfit;
    
    console.log(`[Fill] BUY ${side} ${filledSize} @ ${filledPrice.toFixed(3)} | Cost: $${cost.toFixed(2)} | Tokens: ${isUp ? position.upShares : position.downShares}`);
  } else {
    // SELL MODE: Selling tokens
    const proceeds = cost;
    const grossProfit = proceeds - (filledSize * cycle.lastFairPrice) + rebate;
    cycle.pnlRealized += grossProfit;

    if (isUp) {
      position.upShares -= filledSize;
      position.upSharesCommitted = Math.max(0, position.upSharesCommitted - filledSize);
      const prevTotal = position.upSharesSold * position.upFillPrice;
      position.upSharesSold += filledSize;
      position.upFillPrice = (prevTotal + proceeds) / position.upSharesSold;
      console.log(`[Fill] SELL UP ${filledSize} @ ${filledPrice.toFixed(3)} | Proceeds: $${proceeds.toFixed(2)} | Remaining: ${position.upShares.toFixed(2)}`);
    } else {
      position.downShares -= filledSize;
      position.downSharesCommitted = Math.max(0, position.downSharesCommitted - filledSize);
      const prevTotal = position.downSharesSold * position.downFillPrice;
      position.downSharesSold += filledSize;
      position.downFillPrice = (prevTotal + proceeds) / position.downSharesSold;
      console.log(`[Fill] SELL DOWN ${filledSize} @ ${filledPrice.toFixed(3)} | Proceeds: $${proceeds.toFixed(2)} | Remaining: ${position.downShares.toFixed(2)}`);
    }
    
    // Update min exit prices after sell
    updateMinExitPrices(position);
    if (position.minUpExitPrice > 0 || position.minDownExitPrice > 0) {
      console.log(`[Fill] Min exit prices: UP >= ${position.minUpExitPrice.toFixed(3)}, DOWN >= ${position.minDownExitPrice.toFixed(3)}`);
    }
  }

  order.filledSize += filledSize;
  if (order.filledSize >= order.size) {
    cycle.activeOrders.delete(orderId);
  }

  // Check if we should transition to PARTIAL_FILL or IMBALANCED state
  // For bid mode, imbalance is when one side fills before the other
  const imbalance = calculateImbalance(position.upShares, position.downShares);
  if (cycle.state === BotState.QUOTING) {
    if (imbalance > BOT_CONFIG.risk.largeImbalanceThreshold) {
      cycle.state = BotState.IMBALANCED;
    } else if (imbalance > BOT_CONFIG.risk.smallImbalanceThreshold) {
      cycle.state = BotState.PARTIAL_FILL;
    }
  }
}
