import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { BotConfig, LadderConfig, ProfitabilityConfig, RiskConfig, TimeDecayConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../.env") });

export const CLOB_HOST = "https://clob.polymarket.com";
export const GAMMA_HOST = "https://gamma-api.polymarket.com";
export const CHAIN_ID = 137;

export const RPC_CONFIG = {
  delayMs: parseInt(process.env.RPC_DELAY_MS || "1000"),
  maxRetries: parseInt(process.env.RPC_MAX_RETRIES || "3"),
  retryDelayMs: parseInt(process.env.RPC_RETRY_DELAY_MS || "3000"),
};

export const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
export const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || "";

export const CLOB_CREDS = process.env.CLOB_API_KEY
  ? {
      key: process.env.CLOB_API_KEY,
      secret: process.env.CLOB_SECRET || "",
      passphrase: process.env.CLOB_PASSPHRASE || "",
    }
  : null;

// PRD §5.1 & §7: Profitability filter config
const profitability: ProfitabilityConfig = {
  // PRD §3.4: 100% of taker fees redistributed to makers
  rebatePoolPercent: parseFloat(process.env.REBATE_POOL_PERCENT || "1.0"),
  minEdgeUSD: parseFloat(process.env.MIN_EDGE_USD || "0.004"), // ~0.4¢ min edge
  includeSpread: true,
  // PRD §5.1: Expected imbalance loss −0.6¢ to −1.4¢ per $1 split
  expectedLossPerShare: parseFloat(process.env.EXPECTED_LOSS_PER_SHARE || "0.01"),
};

// PRD §6: Quote Construction (Dynamic Ladder)
const ladder: LadderConfig = {
  maxSpread: parseFloat(process.env.MAX_SPREAD || "0.03"), // 5¢ default (wider for 0.01 tick)
  levels: parseInt(process.env.LADDER_LEVELS || "3"),
  minLevelSpacing: 0.01, // Minimum tick size for crypto markets
};

// PRD §8 & §13: Risk Management
const risk: RiskConfig = {
  maxUnrealizedLossUSD: parseFloat(process.env.MAX_UNREALIZED_LOSS_USD || "20"),
  // PRD §8.3: Response matrix thresholds
  smallImbalanceThreshold: parseFloat(process.env.SMALL_IMBALANCE_THRESHOLD || "0.20"),
  largeImbalanceThreshold: parseFloat(process.env.LARGE_IMBALANCE_THRESHOLD || "0.40"),
  // PRD §9: Time decay thresholds
  panicTimeSec: parseFloat(process.env.PANIC_TIME_SEC || "60"),
  stopNewOrdersSec: parseFloat(process.env.STOP_NEW_ORDERS_SEC || "120"),
  maxExposureUSD: parseFloat(process.env.MAX_EXPOSURE_USD || "500"),
  // Allowed price region - widened from PRD 40-60% to be practical
  allowedPriceMin: parseFloat(process.env.ALLOWED_PRICE_MIN || "0.30"),
  allowedPriceMax: parseFloat(process.env.ALLOWED_PRICE_MAX || "0.70"),
  // Imbalance handling: hold before selling, stop loss threshold
  imbalanceHoldMs: parseFloat(process.env.IMBALANCE_HOLD_MS || "5000"), // 5s default
  imbalanceStopLossPct: parseFloat(process.env.IMBALANCE_STOP_LOSS_PCT || "0.15"), // 15% stop loss
};

// PRD §9: Time Decay & Settlement Logic
const timeDecay: TimeDecayConfig = {
  normalOperationMin: 5,
  reducedSizeMin: 2,
  stopNewQuotesSec: 120, // PRD §9: <120s → stop new orders
  forceResolutionSec: 60, // PRD §9: <60s → force flatten
};

export const BOT_CONFIG: BotConfig = {
  profitability,
  ladder,
  risk,
  timeDecay,
  capitalUSD: parseFloat(process.env.CAPITAL_USD || "100"),
  recenterThreshold: 0.002, // PRD §6.2: recenter when mid moves >0.002
  minOrderSize: 5, // PRD §3.3: orderMinSize = 5 shares
  farmingMode: (process.env.FARMING_MODE || "bid") as "sell" | "bid", // "sell" or "bid"
  maxBidSum: parseFloat(process.env.MAX_BID_SUM || "0.985"), // For bid mode: UP+DOWN bids must sum to < this
};
