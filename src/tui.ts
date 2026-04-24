import { BotState, type MarketCycle } from "./types.js";
import { getWalletBalance, getPositions, type PositionInfo, type WalletBalance } from "./wallet.js";
import { BOT_CONFIG } from "./config.js";
import { wsManager } from "./websocket.js";
import { getCurrentWindowStart, getNextWindowStart, formatWindowTime } from "./markets.js";

const REFRESH_INTERVAL = 500; // 500ms for smooth price updates

interface TUIState {
  cycles: Map<string, MarketCycle>;
  wallet: WalletBalance | null;
  positions: PositionInfo[];
  lastUpdate: Date;
  isRunning: boolean;
}

const state: TUIState = {
  cycles: new Map(),
  wallet: null,
  positions: [],
  lastUpdate: new Date(),
  isRunning: false,
};

export function updateCycles(cycles: Map<string, MarketCycle>): void {
  state.cycles = cycles;
  state.lastUpdate = new Date();
}

function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[0f");
}

function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1B[${row};${col}H`);
}

function color(text: string, colorCode: number): string {
  return `\x1B[${colorCode}m${text}\x1B[0m`;
}

const Colors = {
  green: (t: string) => color(t, 32),
  red: (t: string) => color(t, 31),
  yellow: (t: string) => color(t, 33),
  cyan: (t: string) => color(t, 36),
  white: (t: string) => color(t, 37),
  bold: (t: string) => color(t, 1),
  dim: (t: string) => color(t, 2),
};

function stateColor(s: BotState): string {
  switch (s) {
    case BotState.IDLE:
      return Colors.dim(s);
    case BotState.SPLIT:
      return Colors.cyan(s);
    case BotState.QUOTING:
      return Colors.green(s);
    case BotState.PARTIAL_FILL:
      return Colors.yellow(s);
    case BotState.IMBALANCED:
      return Colors.yellow(s);
    case BotState.EXITING:
      return Colors.red(s);
    case BotState.HALTED:
      return Colors.dim(s);
    default:
      return s;
  }
}

function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  const colorFn = pnl >= 0 ? Colors.green : Colors.red;
  return colorFn(`${sign}$${pnl.toFixed(2)}`);
}

function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
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
  const title = "╔══════════════════════════════════════════════════════════════════════════════╗";
  const name = "║              POLYMARKET DYNAMIC REBATE FARMING BOT                           ║";
  const bottom = "╚══════════════════════════════════════════════════════════════════════════════╝";

  console.log(Colors.cyan(title));
  console.log(Colors.cyan(name));
  console.log(Colors.cyan(bottom));
  
  const windowStart = getCurrentWindowStart(15 * 60);
  const windowEnd = getNextWindowStart(15 * 60);
  console.log(`  Window: ${Colors.bold(formatWindowTime(windowStart))} - ${formatWindowTime(windowEnd)}  |  Next: ${Colors.yellow(formatCountdown())}`);
}

function drawWallet(): void {
  if (!state.wallet) return;

  const { usdcBalance, holdingsValue, totalEquity } = state.wallet;

  console.log(Colors.bold("\n💰 WALLET"));
  console.log("─".repeat(40));
  console.log(`  USDC:      $${usdcBalance.toFixed(2).padStart(10)}`);
  console.log(`  Holdings:  $${holdingsValue.toFixed(2).padStart(10)}`);
  console.log(`  ${Colors.bold("Equity:")}   ${Colors.bold("$" + totalEquity.toFixed(2).padStart(10))}`);
}

function drawConfig(): void {
  console.log(Colors.bold("\n⚙️  CONFIG"));
  console.log("─".repeat(40));
  console.log(`  Capital/Cycle: $${BOT_CONFIG.capitalUSD}`);
  console.log(`  Rebate Pool:   ${(BOT_CONFIG.profitability.rebatePoolPercent * 100).toFixed(0)}%`);
  console.log(`  Max Loss:      $${BOT_CONFIG.risk.maxUnrealizedLossUSD}`);
  console.log(`  Panic Time:    ${BOT_CONFIG.risk.panicTimeSec}s`);
}

function formatPrice(price: number): string {
  return price.toFixed(3);
}

function formatSum(sum: number): string {
  if (sum < 0.98) {
    return Colors.green(sum.toFixed(3)); // Good for BID
  } else if (sum > 1.02) {
    return Colors.red(sum.toFixed(3)); // Good for ASK  
  }
  return Colors.dim(sum.toFixed(3));
}

function drawLivePrices(): void {
  console.log(Colors.bold("\n📊 LIVE PRICES"));
  console.log("─".repeat(78));
  
  console.log(
    Colors.dim("  ") +
    Colors.dim("Asset".padEnd(8)) +
    Colors.dim("UP Bid".padEnd(10)) +
    Colors.dim("UP Ask".padEnd(10)) +
    Colors.dim("DOWN Bid".padEnd(10)) +
    Colors.dim("DOWN Ask".padEnd(10)) +
    Colors.dim("Bid Σ".padEnd(10)) +
    Colors.dim("Ask Σ".padEnd(10))
  );
  console.log("─".repeat(78));
  
  const seenAssets = new Set<string>();
  
  for (const [_, cycle] of state.cycles) {
    const market = cycle.marketInfo;
    const assetMatch = market.question.match(/Will (BTC|ETH|SOL|DOGE)/i);
    const asset = assetMatch ? assetMatch[1].toUpperCase() : market.question.slice(5, 11);
    
    if (seenAssets.has(asset)) continue;
    seenAssets.add(asset);
    
    const upBid = wsManager.getBestBid(market.upTokenId);
    const upAsk = wsManager.getBestAsk(market.upTokenId);
    const downBid = wsManager.getBestBid(market.downTokenId);
    const downAsk = wsManager.getBestAsk(market.downTokenId);
    
    const bidSum = upBid + downBid;
    const askSum = upAsk + downAsk;
    
    console.log(
      "  " +
      Colors.bold(asset.padEnd(8)) +
      Colors.green(formatPrice(upBid).padEnd(10)) +
      Colors.red(formatPrice(upAsk).padEnd(10)) +
      Colors.green(formatPrice(downBid).padEnd(10)) +
      Colors.red(formatPrice(downAsk).padEnd(10)) +
      formatSum(bidSum).padEnd(20) +
      formatSum(askSum)
    );
  }
  
  if (state.cycles.size === 0) {
    console.log(Colors.dim("  Waiting for market subscriptions..."));
  }
}

function drawCycles(): void {
  console.log(Colors.bold("\n🔄 ACTIVE CYCLES"));
  console.log("─".repeat(78));

  if (state.cycles.size === 0) {
    console.log(Colors.dim("  No active market cycles. Scanning for markets..."));
    return;
  }

  console.log(
    Colors.dim(
      "  " +
        "Market".padEnd(20) +
        "State".padEnd(12) +
        "Time".padEnd(8) +
        "UP".padEnd(8) +
        "DOWN".padEnd(8) +
        "PnL".padEnd(12)
    )
  );
  console.log("─".repeat(78));

  for (const [_, cycle] of state.cycles) {
    const timeRemaining = Math.max(0, (cycle.marketInfo.endDate.getTime() - Date.now()) / 1000);
    const assetMatch = cycle.marketInfo.question.match(/Will (BTC|ETH|SOL|DOGE)/i);
    const marketName = assetMatch ? `${assetMatch[1]} ${cycle.marketInfo.duration || "15m"}` : cycle.marketInfo.question.slice(0, 18);

    const row =
      "  " +
      marketName.padEnd(20) +
      stateColor(cycle.state).padEnd(22) + // Extra padding for ANSI codes
      formatTime(timeRemaining).padEnd(8) +
      cycle.position.upShares.toString().padEnd(8) +
      cycle.position.downShares.toString().padEnd(8) +
      formatPnL(cycle.pnlRealized);

    console.log(row);
  }
}

function drawPositions(): void {
  if (state.positions.length === 0) return;

  console.log(Colors.bold("\n📈 ON-CHAIN POSITIONS"));
  console.log("─".repeat(78));
  console.log(
    Colors.dim(
      "  " +
        "Outcome".padEnd(12) +
        "Size".padEnd(10) +
        "Avg Price".padEnd(12) +
        "Cur Price".padEnd(12) +
        "PnL".padEnd(15) +
        "%"
    )
  );
  console.log("─".repeat(78));

  for (const pos of state.positions) {
    const pnlStr = formatPnL(pos.pnl);
    const pctStr = pos.pnlPercent >= 0 ? Colors.green(`+${pos.pnlPercent.toFixed(1)}%`) : Colors.red(`${pos.pnlPercent.toFixed(1)}%`);

    console.log(
      "  " +
        pos.outcome.slice(0, 10).padEnd(12) +
        pos.size.toFixed(2).padEnd(10) +
        `$${pos.avgPrice.toFixed(3)}`.padEnd(12) +
        `$${pos.currentPrice.toFixed(3)}`.padEnd(12) +
        pnlStr.padEnd(25) + // Extra padding for ANSI
        pctStr
    );
  }
}

function drawStats(): void {
  let totalRealized = 0;
  let totalOrders = 0;

  for (const [_, cycle] of state.cycles) {
    totalRealized += cycle.pnlRealized;
    totalOrders += cycle.activeOrders.size;
  }

  console.log(Colors.bold("\n📉 SESSION STATS"));
  console.log("─".repeat(40));
  console.log(`  Active Cycles:  ${state.cycles.size}`);
  console.log(`  Open Orders:    ${totalOrders}`);
  console.log(`  Realized PnL:   ${formatPnL(totalRealized)}`);
  console.log(`  Last Update:    ${state.lastUpdate.toLocaleTimeString()}`);
}

function drawFooter(): void {
  console.log("\n" + "─".repeat(78));
  console.log(Colors.dim("  Press Ctrl+C to stop | Auto-refresh every 2s"));
}

async function refreshData(): Promise<void> {
  try {
    const [wallet, positions] = await Promise.all([getWalletBalance(), getPositions()]);
    state.wallet = wallet;
    state.positions = positions;
  } catch (err) {
    console.error("[TUI] Error refreshing data:", err);
  }
}

export async function startTUI(cycles: Map<string, MarketCycle>): Promise<void> {
  state.isRunning = true;
  state.cycles = cycles;

  await refreshData();

  const render = async () => {
    if (!state.isRunning) return;

    state.cycles = cycles;
    clearScreen();
    moveCursor(1, 1);

    drawHeader();
    drawWallet();
    drawLivePrices();
    drawCycles();
    drawPositions();
    drawStats();
    drawFooter();
  };

  await render();

  const renderInterval = setInterval(render, REFRESH_INTERVAL);
  const dataInterval = setInterval(refreshData, 10000);

  process.on("SIGINT", () => {
    state.isRunning = false;
    clearInterval(renderInterval);
    clearInterval(dataInterval);
  });
}

export function stopTUI(): void {
  state.isRunning = false;
}
