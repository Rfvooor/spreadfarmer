import { wsManager } from "./websocket.js";
import { getCurrentWindowStart, getNextWindowStart, formatWindowTime, type MarketType } from "./markets.js";
import type { MarketInfo } from "./types.js";

const REFRESH_INTERVAL = 500; // 500ms for smooth updates

interface SpreadPosition {
  market: MarketInfo;
  state: string;
  direction: "BID" | "ASK";
  realizedPnL: number;
}

interface TUIState {
  positions: Map<string, SpreadPosition>;
  marketType: MarketType;
  totalPnL: number;
  isRunning: boolean;
  logs: string[];
}

const state: TUIState = {
  positions: new Map(),
  marketType: "all",
  totalPnL: 0,
  isRunning: false,
  logs: [],
};

const MAX_LOGS = 8;

function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[0f");
}

function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1B[${row};${col}H`);
}

function color(text: string, colorCode: number): string {
  return `\x1B[${colorCode}m${text}\x1B[0m`;
}

const C = {
  green: (t: string) => color(t, 32),
  red: (t: string) => color(t, 31),
  yellow: (t: string) => color(t, 33),
  cyan: (t: string) => color(t, 36),
  white: (t: string) => color(t, 37),
  bold: (t: string) => color(t, 1),
  dim: (t: string) => color(t, 2),
  bgGreen: (t: string) => `\x1B[42m\x1B[30m${t}\x1B[0m`,
  bgRed: (t: string) => `\x1B[41m\x1B[37m${t}\x1B[0m`,
};

function formatPrice(price: number): string {
  return price.toFixed(3);
}

function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  const colorFn = pnl >= 0 ? C.green : C.red;
  return colorFn(`${sign}$${pnl.toFixed(2)}`);
}

function formatSum(sum: number): string {
  if (sum < 0.98) {
    return C.green(sum.toFixed(3)); // Good for BID
  } else if (sum > 1.02) {
    return C.red(sum.toFixed(3)); // Good for ASK
  }
  return C.dim(sum.toFixed(3));
}

function formatCountdown(): string {
  const now = Math.floor(Date.now() / 1000);
  const next15m = getNextWindowStart(15 * 60);
  const remaining = next15m - now;
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function drawHeader(): void {
  const windowStart = getCurrentWindowStart(15 * 60);
  const windowEnd = getNextWindowStart(15 * 60);
  
  console.log(C.cyan("╔══════════════════════════════════════════════════════════════════════════════╗"));
  console.log(C.cyan("║") + C.bold("           POLYMARKET SPREAD TRADER (WEBSOCKET)                    ") + C.cyan("         ║"));
  console.log(C.cyan("╚══════════════════════════════════════════════════════════════════════════════╝"));
  
  console.log(`  Window: ${C.bold(formatWindowTime(windowStart))} - ${formatWindowTime(windowEnd)}  |  Next: ${C.yellow(formatCountdown())}  |  Mode: ${C.cyan(state.marketType.toUpperCase())}`);
}

function drawPriceTable(): void {
  console.log(C.bold("\n📊 LIVE ORDERBOOKS"));
  console.log("─".repeat(78));
  
  // Header
  console.log(
    C.dim("  ") +
    C.dim("Asset".padEnd(8)) +
    C.dim("UP Bid".padEnd(10)) +
    C.dim("UP Ask".padEnd(10)) +
    C.dim("DOWN Bid".padEnd(10)) +
    C.dim("DOWN Ask".padEnd(10)) +
    C.dim("Bid Sum".padEnd(10)) +
    C.dim("Ask Sum".padEnd(10))
  );
  console.log("─".repeat(78));
  
  // Get all subscribed markets
  const markets = Array.from(state.positions.values()).map(p => p.market);
  const seenAssets = new Set<string>();
  
  for (const market of markets) {
    // Extract asset name from question (e.g., "BTC" from "Will BTC go up...")
    const assetMatch = market.question.match(/Will (BTC|ETH|SOL|DOGE)/i);
    const asset = assetMatch ? assetMatch[1].toUpperCase() : market.question.slice(0, 6);
    
    if (seenAssets.has(asset)) continue;
    seenAssets.add(asset);
    
    const upBid = wsManager.getBestBid(market.upTokenId);
    const upAsk = wsManager.getBestAsk(market.upTokenId);
    const downBid = wsManager.getBestBid(market.downTokenId);
    const downAsk = wsManager.getBestAsk(market.downTokenId);
    
    const bidSum = upBid + downBid;
    const askSum = upAsk + downAsk;
    
    // Color based on opportunity
    const bidSumStr = bidSum < 0.98 ? C.bgGreen(` ${bidSum.toFixed(3)} `) : formatSum(bidSum);
    const askSumStr = askSum > 1.02 ? C.bgRed(` ${askSum.toFixed(3)} `) : formatSum(askSum);
    
    console.log(
      "  " +
      C.bold(asset.padEnd(8)) +
      C.green(formatPrice(upBid).padEnd(10)) +
      C.red(formatPrice(upAsk).padEnd(10)) +
      C.green(formatPrice(downBid).padEnd(10)) +
      C.red(formatPrice(downAsk).padEnd(10)) +
      bidSumStr.padEnd(20) +  // Extra for ANSI
      askSumStr
    );
  }
  
  if (markets.length === 0) {
    console.log(C.dim("  Waiting for market subscriptions..."));
  }
}

function drawPositions(): void {
  console.log(C.bold("\n📈 ACTIVE POSITIONS"));
  console.log("─".repeat(78));
  
  if (state.positions.size === 0) {
    console.log(C.dim("  No active positions"));
    return;
  }
  
  console.log(
    C.dim("  ") +
    C.dim("Market".padEnd(20)) +
    C.dim("Dir".padEnd(6)) +
    C.dim("State".padEnd(14)) +
    C.dim("PnL".padEnd(12))
  );
  
  for (const [_, pos] of state.positions) {
    const asset = pos.market.question.match(/Will (BTC|ETH|SOL|DOGE)/i)?.[1] || "???";
    const duration = pos.market.duration || "15m";
    const dirColor = pos.direction === "BID" ? C.green : C.red;
    
    console.log(
      "  " +
      `${asset} ${duration}`.padEnd(20) +
      dirColor(pos.direction.padEnd(6)) +
      pos.state.padEnd(14) +
      formatPnL(pos.realizedPnL)
    );
  }
}

function drawStats(): void {
  console.log(C.bold("\n💰 SESSION"));
  console.log("─".repeat(40));
  console.log(`  Active Positions: ${state.positions.size}`);
  console.log(`  Total PnL:        ${formatPnL(state.totalPnL)}`);
  console.log(`  WebSocket:        ${wsManager.isReady() ? C.green("CONNECTED") : C.red("DISCONNECTED")}`);
}

function drawLogs(): void {
  if (state.logs.length === 0) return;
  
  console.log(C.bold("\n📝 RECENT ACTIVITY"));
  console.log("─".repeat(78));
  
  for (const log of state.logs.slice(-MAX_LOGS)) {
    console.log(C.dim("  " + log));
  }
}

function drawFooter(): void {
  console.log("\n" + "─".repeat(78));
  console.log(C.dim("  Press Ctrl+C to stop | Updates every 500ms | Real-time via WebSocket"));
}

function render(): void {
  if (!state.isRunning) return;
  
  clearScreen();
  moveCursor(1, 1);
  
  drawHeader();
  drawPriceTable();
  drawPositions();
  drawStats();
  drawLogs();
  drawFooter();
}

// Public API
export function initSpreadTUI(marketType: MarketType): void {
  state.marketType = marketType;
  state.isRunning = true;
  
  // Start render loop
  setInterval(render, REFRESH_INTERVAL);
}

export function updatePositions(positions: Map<string, SpreadPosition>): void {
  state.positions = positions;
}

export function updateTotalPnL(pnl: number): void {
  state.totalPnL = pnl;
}

export function addLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  state.logs.push(`[${timestamp}] ${message}`);
  if (state.logs.length > MAX_LOGS * 2) {
    state.logs = state.logs.slice(-MAX_LOGS);
  }
}

export function stopSpreadTUI(): void {
  state.isRunning = false;
}
