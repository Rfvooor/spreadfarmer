import { initClient } from "./client.js";
import { BOT_CONFIG } from "./config.js";
import { fetch15MinCryptoMarkets, getTimeToSettlement, getCurrentWindowStart } from "./markets.js";
import { cancelAllOrders, getOrder } from "./orders.js";
import {
  createMarketCycle,
  executeStateActions,
  transitionState,
  handleFillEvent,
} from "./state-machine.js";
import { BotState, type MarketCycle } from "./types.js";
import { getWalletBalance, logWalletStatus } from "./wallet.js";
import { startTUI, stopTUI, updateCycles } from "./tui.js";
import { wsManager } from "./websocket.js";
import { runRedemptionCheck, shouldRunRedemption } from "./redemption.js";

const activeCycles: Map<string, MarketCycle> = new Map();
let isRunning = false;
let useTUI = true;

async function getAvailableCapital(): Promise<number> {
  try {
    const wallet = await getWalletBalance();
    const maxCapital = BOT_CONFIG.capitalUSD;
    const availableUsdc = wallet.usdcBalance;
    
    if (availableUsdc < maxCapital * 0.5) {
      console.log(`[Bot] Low USDC balance: $${availableUsdc.toFixed(2)} (need at least $${(maxCapital * 0.5).toFixed(2)})`);
      return 0;
    }

    return Math.min(availableUsdc * 0.9, maxCapital);
  } catch (err) {
    console.error("[Bot] Error fetching wallet balance:", err);
    return BOT_CONFIG.capitalUSD;
  }
}

/**
 * Poll for order fills and update cycle state
 */
async function pollOrderFills(cycle: MarketCycle): Promise<void> {
  for (const [orderId, order] of cycle.activeOrders) {
    try {
      const currentOrder = await getOrder(orderId);
      if (!currentOrder) {
        // Order no longer exists (cancelled or fully filled)
        cycle.activeOrders.delete(orderId);
        continue;
      }
      
      const newFills = currentOrder.filledSize - order.filledSize;
      if (newFills > 0) {
        await handleFillEvent(cycle, orderId, newFills, order.price);
      }
    } catch (err) {
      // Ignore polling errors for individual orders
    }
  }
}

/**
 * Run a single iteration of the cycle (non-blocking)
 */
async function tickCycle(cycle: MarketCycle): Promise<boolean> {
  if (cycle.state === BotState.HALTED) return false;
  
  // Poll for fills first
  await pollOrderFills(cycle);
  
  // Transition state
  const newState = await transitionState(cycle);
  if (newState !== cycle.state) {
    if (!useTUI) {
      console.log(`[Bot] ${cycle.marketInfo.question.slice(0, 20)}: ${cycle.state} -> ${newState}`);
    }
    cycle.state = newState;
  }

  // Execute actions for current state
  await executeStateActions(cycle);
  
  return cycle.state !== BotState.HALTED;
}

/**
 * Initialize a new cycle and add it to active cycles
 */
async function startCycle(cycle: MarketCycle): Promise<void> {
  const { marketInfo } = cycle;
  
  if (!useTUI) {
    console.log(`\n[Bot] Starting cycle for: ${marketInfo.question}`);
    console.log(`[Bot] Mode: ${cycle.mode.toUpperCase()}`);
    console.log(`[Bot] End Date: ${marketInfo.endDate.toISOString()}`);
  }
  
  activeCycles.set(marketInfo.conditionId, cycle);
  updateCycles(activeCycles);
}

/**
 * Remove completed cycle
 */
function endCycle(cycle: MarketCycle): void {
  if (!useTUI) {
    console.log(`\n[Bot] Cycle complete for: ${cycle.marketInfo.question.slice(0, 30)}`);
    console.log(`[Bot] Final PnL: $${cycle.pnlRealized.toFixed(2)}`);
    console.log(`[Bot] Remaining: ${cycle.position.upShares} UP, ${cycle.position.downShares} DOWN`);
  }
  
  wsManager.unsubscribeMarket(cycle.marketInfo);
  activeCycles.delete(cycle.marketInfo.conditionId);
  updateCycles(activeCycles);
}

let isScanning = false;
let lastScanFoundMarkets = true;
let consecutiveEmptyScans = 0;

async function scanForMarkets(): Promise<void> {
  if (isScanning) return;
  isScanning = true;
  
  if (!useTUI) {
    console.log("\n[Bot] Scanning for 15-minute crypto markets...");
  }
  
  try {
    const markets = await fetch15MinCryptoMarkets();
    
    if (markets.length === 0) {
      consecutiveEmptyScans++;
      lastScanFoundMarkets = false;
      if (!useTUI) {
        console.log(`[Bot] No markets found (attempt ${consecutiveEmptyScans}). Will retry in ${consecutiveEmptyScans < 3 ? '10s' : '30s'}...`);
      }
      return;
    }
    
    consecutiveEmptyScans = 0;
    lastScanFoundMarkets = true;
    
    if (!useTUI) {
      console.log(`[Bot] Found ${markets.length} eligible markets`);
    }

    let marketsStarted = 0;
    for (const market of markets) {
      if (activeCycles.has(market.conditionId)) {
        continue;
      }

      const timeRemaining = getTimeToSettlement(market);
      if (timeRemaining < BOT_CONFIG.risk.panicTimeSec * 2) {
        if (!useTUI) {
          console.log(`[Bot] Skipping ${market.question.slice(0, 20)}: only ${Math.floor(timeRemaining)}s remaining`);
        }
        continue;
      }

      if (activeCycles.size >= 10) {
        break;
      }

      const capital = await getAvailableCapital();
      if (capital <= 0) {
        console.log("[Bot] Insufficient capital for new cycle");
        break;
      }

      // Subscribe to websocket for real-time prices
      wsManager.subscribeMarket(market);
      
      const cycle = createMarketCycle(market, capital);
      await startCycle(cycle);
      marketsStarted++;
    }
    
    if (!useTUI && marketsStarted === 0 && markets.length > 0) {
      console.log(`[Bot] All ${markets.length} markets already active or filtered out`);
    }
  } catch (err) {
    console.error("[Bot] Market scan error:", err);
    consecutiveEmptyScans++;
    lastScanFoundMarkets = false;
  } finally {
    isScanning = false;
  }
}

/**
 * Get dynamic scan interval based on state
 */
function getScanInterval(): number {
  if (!lastScanFoundMarkets) {
    // Faster retry when no markets found
    return consecutiveEmptyScans < 3 ? 10000 : 30000;
  }
  if (activeCycles.size === 0) {
    // Faster scan when idle
    return 15000;
  }
  // Normal interval when running
  return 60000;
}

/**
 * Main loop: tick all active cycles concurrently
 */
async function runMainLoop(): Promise<void> {
  while (isRunning) {
    const cyclePromises: Promise<void>[] = [];
    
    for (const [conditionId, cycle] of activeCycles) {
      cyclePromises.push(
        tickCycle(cycle).then((stillActive) => {
          if (!stillActive) {
            endCycle(cycle);
          }
        }).catch((err) => {
          console.error(`[Bot] Cycle tick error for ${conditionId.slice(0, 10)}:`, err);
        })
      );
    }
    
    if (cyclePromises.length > 0) {
      await Promise.all(cyclePromises);
    }
    
    updateCycles(activeCycles);
    await sleep(3000); // 3 second tick interval
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  useTUI = !args.includes("--no-tui");

  if (!useTUI) {
    console.log("=".repeat(60));
    console.log("Polymarket Dynamic Rebate Farming Bot");
    console.log("=".repeat(60));
  }

  await initClient();
  
  // Connect WebSocket for real-time prices
  if (!useTUI) console.log("[Bot] Connecting to WebSocket...");
  await wsManager.connect();
  
  isRunning = true;

  await logWalletStatus();

  process.on("SIGINT", async () => {
    console.log("\n[Bot] Shutting down...");
    isRunning = false;
    stopTUI();
    
    await cancelAllOrders();
    wsManager.disconnect();
    
    console.log("[Bot] Shutdown complete");
    process.exit(0);
  });

  // Initial market scan
  await scanForMarkets();

  if (useTUI) {
    startTUI(activeCycles);
  }

  // Dynamic market scan - uses adaptive interval based on state
  const scheduleScan = () => {
    const interval = getScanInterval();
    setTimeout(async () => {
      if (isRunning) {
        await scanForMarkets();
        scheduleScan(); // Schedule next scan with potentially different interval
      }
    }, interval);
  };
  scheduleScan();

  // Redemption check loop - runs 1 min after each 15m window ends
  setInterval(async () => {
    if (!isRunning) return;
    
    const windowStart = getCurrentWindowStart(15 * 60);
    const windowEnd = windowStart + (15 * 60);
    
    if (shouldRunRedemption(windowEnd - (15 * 60))) { // Previous window end
      try {
        await runRedemptionCheck();
      } catch (err) {
        console.error("[Bot] Redemption check failed:", err);
      }
    }
  }, 10000); // Check every 10s

  // Run main loop (ticks all cycles concurrently)
  await runMainLoop();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});
