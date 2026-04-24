import { GAMMA_HOST } from "./config.js";
import type { MarketInfo, TickSize } from "./types.js";

// All supported assets for UP/DOWN markets
const ALL_ASSETS = ["ETH"];

// Window durations in seconds
const WINDOW_15M = 15 * 60; // 900 seconds
const WINDOW_5M = 5 * 60;   // 300 seconds

export type MarketType = "15m" | "5m" | "all";

interface GammaMarket {
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  endDate: string;
  outcomes: string[];
  outcomePrices: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
  }>;
  negRisk?: boolean;
  acceptingOrders?: boolean;
  closed?: boolean;
  orderPriceMinTickSize?: number;
}

// Track current window to detect transitions
let lastWindow15m = 0;
let lastWindow5m = 0;

/**
 * Get the current 15-minute window start timestamp
 */
export function getCurrentWindowStart(windowSecs: number = WINDOW_15M): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / windowSecs) * windowSecs;
}

/**
 * Get the next window start timestamp
 */
export function getNextWindowStart(windowSecs: number = WINDOW_15M): number {
  return getCurrentWindowStart(windowSecs) + windowSecs;
}

/**
 * Get milliseconds until the next window
 */
export function getMsUntilNextWindow(windowSecs: number = WINDOW_15M): number {
  const nextWindow = getNextWindowStart(windowSecs);
  const now = Math.floor(Date.now() / 1000);
  return (nextWindow - now) * 1000;
}

/**
 * Check if we've entered a new window
 */
export function hasWindowChanged(type: "15m" | "5m"): boolean {
  const windowSecs = type === "15m" ? WINDOW_15M : WINDOW_5M;
  const currentWindow = getCurrentWindowStart(windowSecs);
  const lastWindow = type === "15m" ? lastWindow15m : lastWindow5m;
  
  if (currentWindow !== lastWindow) {
    if (type === "15m") {
      lastWindow15m = currentWindow;
    } else {
      lastWindow5m = currentWindow;
    }
    return lastWindow !== 0; // Don't trigger on first check
  }
  return false;
}

/**
 * Generate market slug for an asset and window
 * Format: {asset}-updown-15m-{unix_start_time}
 */
export function buildMarketSlug(asset: string, windowStart: number, duration: "15m" | "5m" = "15m"): string {
  return `${asset.toLowerCase()}-updown-${duration}-${windowStart}`;
}

/**
 * Generate slugs for all assets in the current window
 */
export function getCurrentMarketSlugs(duration: "15m" | "5m" = "15m"): string[] {
  const windowSecs = duration === "15m" ? WINDOW_15M : WINDOW_5M;
  const windowStart = getCurrentWindowStart(windowSecs);
  return ALL_ASSETS.map(asset => buildMarketSlug(asset, windowStart, duration));
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
  endDate: string;
}

/**
 * Fetch market data by slug
 */
async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  try {
    // Use /markets endpoint (not /events) - matches Rust bot
    const url = `${GAMMA_HOST}/markets?slug=${slug}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`[Markets] HTTP ${response.status} for ${slug}`);
      return null;
    }
    
    const markets = await response.json() as GammaMarket[];
    if (!markets || markets.length === 0) {
      console.error(`[Markets] No market found for slug: ${slug}`);
      return null;
    }
    
    return markets[0];
  } catch (err) {
    console.error(`[Markets] Failed to fetch ${slug}:`, err);
    return null;
  }
}

/**
 * Parse market data into MarketInfo
 */
function parseMarket(
  market: GammaMarket,
  duration: "15m" | "5m"
): MarketInfo | null {
  // Skip inactive markets
  if (market.closed === true) return null;
  if (market.acceptingOrders === false) return null;

  let upTokenId = "";
  let downTokenId = "";

  /**
   * Preferred path: CLOB markets
   * clobTokenIds + outcomes define ordering
   */
  if (market.clobTokenIds && market.outcomes) {
    const tokenIds: string[] =
      typeof market.clobTokenIds === "string"
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;

    const outcomes: string[] =
      typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes;

    if (tokenIds.length === 2 && outcomes.length === 2) {
      for (let i = 0; i < 2; i++) {
        const outcome = outcomes[i].toLowerCase();
        if (outcome === "up" || outcome === "yes") {
          upTokenId = tokenIds[i];
        } else if (outcome === "down" || outcome === "no") {
          downTokenId = tokenIds[i];
        }
      }
    }
  }

  /**
   * Legacy / fallback path (non-CLOB Gamma markets)
   */
  if (!upTokenId || !downTokenId) {
    if (market.tokens && market.tokens.length === 2) {
      for (const token of market.tokens) {
        const outcome = token.outcome.toLowerCase();
        if (outcome.includes("up") || outcome === "yes") {
          upTokenId = token.token_id;
        } else if (outcome.includes("down") || outcome === "no") {
          downTokenId = token.token_id;
        }
      }
    }
  }

  if (!upTokenId || !downTokenId) return null;

  // Use the tick size from the API (usually 0.01 for crypto markets)
  const tickSize = String(market.orderPriceMinTickSize ?? 0.01) as TickSize;
  
  return {
    conditionId: market.conditionId,
    upTokenId,
    downTokenId,
    question: market.question,
    endDate: new Date(market.endDate),
    tickSize,
    negRisk: market.negRisk ?? false,
    duration,
  };
}


/**
 * Fetch all current crypto markets by generating slugs deterministically
 */
export async function fetchCryptoMarkets(options: { type?: MarketType } = {}): Promise<MarketInfo[]> {
  const { type = "all" } = options;
  const markets: MarketInfo[] = [];
  
  // Fetch 15m markets
  if (type === "15m" || type === "all") {
    const slugs15m = getCurrentMarketSlugs("15m");
    console.log(`[Markets] Fetching 15m markets: ${slugs15m.join(", ")}`);
    
    const results = await Promise.all(slugs15m.map(slug => fetchMarketBySlug(slug)));
    for (const market of results) {
      if (market) {
        const parsed = parseMarket(market, "15m");
        if (parsed) {
          const timeRemaining = getTimeToSettlement(parsed);
          // Only include if > 1 min remaining
          if (timeRemaining > 60) {
            markets.push(parsed);
          }
        }
      }
    }
  }
  
  // Fetch 5m markets
  if (type === "5m" || type === "all") {
    const slugs5m = getCurrentMarketSlugs("5m");
    console.log(`[Markets] Fetching 5m markets: ${slugs5m.join(", ")}`);
    
    const results = await Promise.all(slugs5m.map(slug => fetchMarketBySlug(slug)));
    
    for (const market of results) {
      if (market) {
        const parsed = parseMarket(market, "5m");
        if (parsed) {
          const timeRemaining = getTimeToSettlement(parsed);
          // Only include if > 30s remaining for 5m
          if (timeRemaining > 30) {
            markets.push(parsed);
          }
        }
      }
    }
  }
  
  console.log(`[Markets] Found ${markets.length} active markets`);
  return markets;
}

// Legacy functions for backwards compatibility
export async function fetch15MinCryptoMarkets(): Promise<MarketInfo[]> {
  return fetchCryptoMarkets({ type: "15m" });
}

export async function fetch5MinCryptoMarkets(): Promise<MarketInfo[]> {
  return fetchCryptoMarkets({ type: "5m" });
}

export async function fetchAllCryptoMarkets(): Promise<MarketInfo[]> {
  return fetchCryptoMarkets({ type: "all" });
}

export async function getMarketByConditionId(conditionId: string): Promise<MarketInfo | null> {
  const url = `${GAMMA_HOST}/markets?conditionId=${conditionId}`;
  const response = await fetch(url);
  
  if (!response.ok) return null;
  
  const markets = await response.json() as GammaMarket[];
  if (markets.length === 0) return null;

  return parseMarket(markets[0], "15m");
}

export function getTimeToSettlement(market: MarketInfo): number {
  return Math.max(0, market.endDate.getTime() - Date.now()) / 1000;
}

/**
 * Format a timestamp as HH:MM
 */
export function formatWindowTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().slice(11, 16);
}
