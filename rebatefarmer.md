# Polymarket Rebate Farmer – Product Requirements Document (PRD)

## 1. Executive Summary

This product is an **automated rebate-farming liquidity provider** for Polymarket 15-minute crypto markets. Its sole objective is to **systematically earn maker rebates and small probabilistic spread capture** by providing disciplined, mid-price liquidity while tightly controlling inventory risk.

This system is **not a directional trading bot** and **not a traditional market maker**. It is explicitly optimized to:

* Maximize **fee-equivalent rebate weight** under Polymarket’s maker rebate formula
* Operate almost exclusively in the **mid-probability region (≈40%–60%)** where rebates are highest
* Avoid tail exposure, momentum regimes, and informed flow
* Convert frequent small, positive-EV cycles into steady capital growth

The bot trades only when the **expected value is strictly positive after rebates**, and exits aggressively when inventory risk exceeds configured thresholds.

---

## 2. Product Goals & Non-Goals

### 2.1 Goals

* Earn consistent maker rebates in 15-minute crypto markets
* Maintain near-delta-neutral exposure most of the time
* Limit worst-case drawdowns via deterministic risk rules
* Operate continuously without human intervention
* Provide full real-time observability and kill-switch controls

### 2.2 Non-Goals

* Predict market direction
* Capture large single-trade profits
* Provide liquidity deep in the tails (≤30% or ≥70%)
* Compete with ultra-low-latency HFT firms
* Use leverage or borrow capital

---

## 3. Market & Fee Mechanics (Critical Context)

### 3.1 Market Type

* Polymarket **15-minute crypto markets**
* Binary outcome tokens: UP and DOWN
* Prices ∈ [0, 1]
* Settlement at market close

### 3.2 Split Mechanism

* Split converts **$1 USDC → 1 UP + 1 DOWN**
* Split is fee-free and slippage-free
* Split establishes a neutral inventory baseline

### 3.3 Order Constraints

* `orderPriceMinTickSize = 0.001`
* `orderMinSize = 5 shares`

These constraints are **hard requirements** and must be enforced by all order generation logic.

### 3.4 Taker Fees & Maker Rebates

* Taker fees peak at ~1.56% near 50% probability
* 100% of taker fees are redistributed to makers (during rebate periods)
* Rebates are **pool-based**, not per-trade

**Fee-Equivalent Formula:**

```
fee_equivalent = shares × price × 0.25 × (price × (1 − price))²
```

**Key Implication:**

* Liquidity near **50% probability** earns disproportionately more rebate weight
* Liquidity in the tails earns near-zero rebate

---

## 4. Strategy Overview

### 4.1 Core Insight

The bot earns money by:

1. Splitting capital into UP/DOWN pairs
2. Posting **tight, symmetric limit orders near mid-price**
3. Allowing natural, noisy flow to fill those orders
4. Collecting maker rebates + small probabilistic spread
5. Repeating frequently with bounded downside

This is equivalent to **selling short-term liquidity insurance** near 50% probability.

### 4.2 What the Strategy Is NOT

* It is not arbitraging visible spreads
* It is not betting on mean reversion
* It is not exploiting mispricing

Visible spreads exist because makers are compensated for **adverse selection risk**.

---

## 5. Economic Model

### 5.1 Per-$1 Split Expected Value (Mid-Regime)

| Component               | Value (Typical)    |
| ----------------------- | ------------------ |
| Maker rebate            | +0.8¢ to +1.6¢     |
| Spread capture          | +0.3¢ to +0.8¢     |
| Expected imbalance loss | −0.6¢ to −1.4¢     |
| **Net EV**              | **+0.4¢ to +1.0¢** |

Equivalent to **~0.4%–1.0% per capital turn**.

### 5.2 Capital Turnover

* 15-minute markets
* 4–8 effective capital turns per day
* Daily ROE (typical): **2%–5%**

---

## 6. Quote Construction (Dynamic Ladder)

### 6.1 Allowed Price Region

```
allowedPrice ∈ [max(0.40, mid − maxSpread), min(0.60, mid + maxSpread)]
```

Default `maxSpread = 0.03` (3¢).

### 6.2 Ladder Generation

For each side (UP and DOWN):

* Generate N price levels spaced by ≥0.001
* Prices are symmetric around mid
* Ladders are rebuilt whenever mid moves >0.002

### 6.3 Size Allocation

Sizes are **rebate-weighted**:

```
rawSize_i ∝ (p_i × (1 − p_i))²
size_i = max(5, round(rawSize_i))
```

Outer levels must never exceed inner level size.

### 6.4 Capital Constraint

If total notional exceeds allocated capital:

* Drop outermost levels first
* Never reduce size below 5 shares

---

## 7. Smart Profitability Filter

Before placing any ladder, the bot must verify:

```
expected_rebate + expected_spread − expected_loss > 0
```

If false:

* Do not quote
* Wait for conditions to normalize

This prevents trading in hostile regimes.

---

## 8. Inventory & Imbalance Management

### 8.1 Normal State

* UP and DOWN inventory roughly balanced
* Both sides quoted

### 8.2 Imbalance Detection

Triggered when:

* One side fills significantly more than the other
* Net exposure > configured threshold

### 8.3 Response Matrix

| Condition                         | Action                  |
| --------------------------------- | ----------------------- |
| Small imbalance, >5 min remaining | Hold + re-quote tighter |
| Large imbalance, >5 min           | Aggressive exit quoting |
| Any imbalance, <2 min             | Market close            |
| Price exits 40–60 band            | Stop rebate farming     |

Asymmetric quotes are **only allowed for risk reduction**, never profit seeking.

---

## 9. Time Decay & Settlement Logic

As expiry approaches:

* Liquidity evaporates
* Directional risk increases
* Rebates no longer justify exposure

Rules:

* <120s remaining → stop placing new orders
* <60s remaining → force inventory flattening
* Never carry inventory through settlement intentionally

---

## 10. State Machine

States:

1. IDLE
2. SPLIT
3. QUOTING
4. PARTIAL_FILL
5. IMBALANCED
6. EXITING
7. HALTED

Transitions are deterministic and based on price, time, and exposure thresholds.

---

## 11. Backend Architecture (TypeScript)

### Core Modules

* MarketScanner
* SplitManager
* QuoteEngine
* InventoryTracker
* RiskEngine
* RebateEstimator
* OrderManager
* StateMachine

All modules are stateless where possible and driven by event streams.

---

## 12. Frontend / GUI Requirements

### 12.1 Dashboard

* Live equity
* Daily rebate estimate
* Active markets
* Net exposure per market
* State per market

### 12.2 Market Detail View

* Current mid
* Active ladders
* Filled orders
* Unrealized P&L
* Time to expiry

### 12.3 Controls

* Global kill switch
* Per-market pause
* Risk preset selector
* Capital allocation controls

### 12.4 Alerts

* Large imbalance
* Price exits allowed band
* Connectivity issues
* Drawdown threshold breach

---

## 13. Risk Management & Circuit Breakers

* Max loss per market
* Max total exposure
* Max concurrent markets
* Auto-halt on consecutive bad cycles
* Manual override always available

---

## 14. Success Metrics

* Rebate earned per day
* Capital turnover rate
* Average inventory hold time
* Forced exits percentage
* Max drawdown

---

## 15. Failure Modes (Explicit)

1. Liquidity collapse → halt
2. Sustained trending regime → halt
3. Rebate program change → halt
4. Settlement delay → freeze capital

---

## 16. Summary (One Sentence)

**This system is a disciplined, rebate-driven liquidity engine that monetizes Polymarket’s incentive structure by operating only where risk is lowest and rebates are highest — and nowhere else.**
