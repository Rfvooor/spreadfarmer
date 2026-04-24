// PRD §10: State Machine - required states
export enum BotState {
  IDLE = "IDLE",
  SPLIT = "SPLIT",
  QUOTING = "QUOTING",
  PARTIAL_FILL = "PARTIAL_FILL",
  IMBALANCED = "IMBALANCED",
  EXITING = "EXITING",
  HALTED = "HALTED",
}

export interface ProfitabilityConfig {
  rebatePoolPercent: number; // PRD §3.4: 100% of taker fees redistributed
  minEdgeUSD: number;
  includeSpread: boolean;
  expectedLossPerShare: number; // PRD §7: expected imbalance loss for EV filter
}

export interface LadderConfig {
  maxSpread: number; // PRD §6.1: default 0.03 (3¢)
  levels: number; // Number of price levels per side
  minLevelSpacing: number; // PRD §3.3: ≥0.001
}

export interface RiskConfig {
  maxUnrealizedLossUSD: number;
  smallImbalanceThreshold: number; // PRD §8.3: response matrix
  largeImbalanceThreshold: number; // PRD §8.3: response matrix
  panicTimeSec: number; // PRD §9: <60s force flatten
  stopNewOrdersSec: number; // PRD §9: <120s stop new orders
  maxExposureUSD: number;
  allowedPriceMin: number; // PRD §6.1: 0.40
  allowedPriceMax: number; // PRD §6.1: 0.60
  imbalanceHoldMs: number; // Hold time before selling imbalanced side
  imbalanceStopLossPct: number; // Stop loss % before forced exit (0.10 = 10%)
}

export interface TimeDecayConfig {
  normalOperationMin: number;
  reducedSizeMin: number;
  stopNewQuotesSec: number; // PRD §9: 120s
  forceResolutionSec: number; // PRD §9: 60s
}

export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

export interface MarketInfo {
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  question: string;
  endDate: Date;
  tickSize: TickSize;
  negRisk: boolean;
  duration?: "15m" | "5m";
}

export interface Position {
  upShares: number;
  downShares: number;
  costBasisUSD: number;
  // Tracking for break-even calculations
  upSharesCommitted: number; // shares locked in open orders
  downSharesCommitted: number;
  upFillPrice: number; // weighted avg price of filled UP sells
  downFillPrice: number; // weighted avg price of filled DOWN sells
  upSharesSold: number; // total UP shares sold
  downSharesSold: number; // total DOWN shares sold
  // Computed min exit prices (updated on fills/sync)
  minUpExitPrice: number; // min price to sell UP to breakeven (based on DOWN sold)
  minDownExitPrice: number; // min price to sell DOWN to breakeven (based on UP sold)
}

export interface OrderInfo {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledSize: number;
}

export interface LadderLevel {
  price: number;
  sizeShares: number;
  side: "UP" | "DOWN";
  orderSide: "BUY" | "SELL";
  expectedRebate: number;
}

export type FarmingMode = "sell" | "bid"; // sell = split then sell, bid = place buy orders

export interface MarketCycle {
  marketInfo: MarketInfo;
  state: BotState;
  position: Position;
  activeOrders: Map<string, OrderInfo>;
  upLadder: LadderLevel[];
  downLadder: LadderLevel[];
  startTime: Date;
  lastFairPrice: number;
  pnlRealized: number;
  pnlUnrealized: number;
  mode: FarmingMode;
  imbalanceDetectedAt: number | null; // Timestamp when imbalance was first detected
  lastPositionSync: number; // Timestamp of last on-chain position sync
}

export interface BotConfig {
  profitability: ProfitabilityConfig;
  ladder: LadderConfig;
  risk: RiskConfig;
  timeDecay: TimeDecayConfig;
  capitalUSD: number;
  recenterThreshold: number; // PRD §6.2: recenter when mid moves >0.002
  minOrderSize: number; // PRD §3.3: 5 shares
  farmingMode: FarmingMode; // "sell" = split+sell, "bid" = buy orders
  maxBidSum: number; // For bid mode: max total for UP+DOWN bids (e.g., 0.98)
}
