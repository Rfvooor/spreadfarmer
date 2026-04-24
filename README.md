# Polymarket 15-Minute Crypto Market Trading Bot

Two trading strategies for Polymarket's 15-minute UP/DOWN crypto markets, optimized for the **Maker Rebates Program**.

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your PRIVATE_KEY and FUNDER_ADDRESS

# Build
npm run build

# Run rebate farmer (places maker orders at 0.501/0.500)
npm start

# Run spread trader (waits for favorable bid sums)
npm run spread
```

---

## Strategy 1: Rebate Farmer (State Machine)

**Command:** `npm start` or `npm start -- --no-tui`

Splits USDC into UP+DOWN tokens, then posts **maker sell orders** at tight prices (e.g., 0.501) to earn rebates when takers hit your orders.

### How It Works

1. **Split** - Convert USDC → matched UP/DOWN tokens on-chain
2. **Quote** - Post laddered sell orders on both sides at prices like 0.501
3. **Capture** - Earn maker rebates (up to 1.56% at 50% price) when orders fill
4. **Manage** - Handle imbalances, time decay, and forced resolution

### When to Use

- You want **passive income** from maker rebates
- You're comfortable holding both sides and earning on fills
- You want the bot to automatically manage inventory

### Key Config

| Variable | Default | Description |
|----------|---------|-------------|
| `CAPITAL_USD` | 100 | USDC to split per market cycle |
| `REBATE_POOL_PERCENT` | 1.0 | Current rebate pool (100% = all taker fees) |
| `PANIC_TIME_SEC` | 60 | Force close positions before settlement |

### Ladder Levels (in `src/config.ts`)

```typescript
levels: [0.02, 0.04, 0.06, 0.08],  // Offsets from fair price
sizePercents: [0.40, 0.30, 0.20, 0.10],  // % of shares per level
```

At fair price 0.50, this quotes SELL orders at: 0.52, 0.54, 0.56, 0.58

---

## Strategy 2: Spread Trader

**Command:** `npm run spread`

Uses **WebSocket** for real-time orderbook updates. Watches for mispricing and trades **both directions**:
- **BID mode**: Buy both sides when bid sum < $1 (cheap entry)
- **ASK mode**: Sell both sides when ask sum > $1 (expensive exit)

### How It Works

1. **Connect** - WebSocket subscription for real-time orderbook data
2. **Scan** - Find markets where bid sum < $0.98 OR ask sum > $1.02
3. **BID**: Place BUY orders on both sides → profit when both fill (guaranteed $1 at settlement)
4. **ASK**: Pre-split USDC → place SELL orders on both sides → profit = proceeds - $1 cost
5. **Auto-cycle** - When markets resolve, automatically picks up next window

### When to Use

- **BID mode**: Markets are underpriced (bid sum << $1.00)
- **ASK mode**: Markets are overpriced (ask sum >> $1.00)
- You want to capture mispricing, not just rebates

### Key Config

| Variable | Default | Description |
|----------|---------|-------------|
| `MARKET_TYPE` | all | `15m`, `5m`, or `all` |
| `MARGIN_FROM_MID` | 0.02 | Offset from best bid/ask |
| `ORDER_SIZE_USD` | 50 | Size per side |
| `MIN_SPREAD_TO_ENTER` | 0.02 | Enter if bid sum < 0.98 or ask sum > 1.02 |
| `TIME_TO_EXPIRE_SEC` | 120 | Cancel unfilled orders after 2 min |
| `MAX_LOSS_PCT` | 0.05 | Stop loss at 5% of position value |
| `MAX_ACTIVE_POSITIONS` | 10 | Max concurrent positions |
| `ENABLE_BID_SIDE` | true | Enable buying both sides when cheap |
| `ENABLE_ASK_SIDE` | true | Enable selling pre-split inventory when expensive |
| `PRE_SPLIT_USD` | 100 | USDC to split for ASK-side inventory |

### Profit Examples

**BID Mode** (buy cheap):
```
UP bid: 0.48, DOWN bid: 0.48 → Bid sum: $0.96
Buy 100 UP @ 0.48 + 100 DOWN @ 0.48 = $96 cost
At settlement: 100 × $1 = $100
Profit: $4 (4.2%)
```

**ASK Mode** (sell expensive):
```
UP ask: 0.52, DOWN ask: 0.52 → Ask sum: $1.04
Sell 100 UP @ 0.52 + 100 DOWN @ 0.52 = $104 proceeds
Inventory cost: 100 × $1 = $100 (from split)
Profit: $4 (4.0%)
```

---

## Fee Curve & Rebates

Polymarket uses a **fee-curve weighted** rebate formula:

```
fee_equivalent = shares × price × 0.25 × (price × (1 - price))²
rebate = fee_equivalent × rebate_pool_percent
```

### Effective Rates by Price

| Price | Effective Fee Rate | Notes |
|-------|-------------------|-------|
| $0.10 | 0.20% | Low rebates at extremes |
| $0.25 | 0.88% | |
| $0.50 | **1.56%** | Maximum rebates |
| $0.75 | 0.88% | |
| $0.90 | 0.20% | Low rebates at extremes |

**Implication:** Quoting near 50% probability earns the highest rebates.

---

## Tick Size

15-minute crypto markets use **0.001** tick size (3 decimal places).

Valid prices: 0.001, 0.002, ... 0.500, 0.501, ... 0.999

---

## Architecture

```
src/
├── index.ts          # Rebate farmer entry point
├── spread-trader.ts  # Spread trader entry point
├── config.ts         # Environment config
├── types.ts          # TypeScript interfaces
├── client.ts         # CLOB client initialization
├── markets.ts        # Gamma API for market discovery
├── pricing.ts        # Fair price, fee curve, ladder building
├── orders.ts         # Order placement/cancellation
├── split-merge.ts    # On-chain CTF split/merge
├── state-machine.ts  # Rebate farmer state transitions
├── wallet.ts         # On-chain balance + positions
└── tui.ts            # Terminal UI dashboard
```

---

## Risk Management

Both strategies include:

- **Panic Time** - Force close all positions before settlement
- **Max Loss** - Stop out if unrealized loss exceeds threshold
- **Imbalance Hold** - Wait before selling imbalanced side (allows price recovery)
- **Stop Loss** - Exit if loss exceeds % of cost basis
- **Position Sync** - Periodically sync with on-chain balances to prevent desync
- **Graceful Shutdown** - CTRL+C cancels all orders immediately

---

## Environment Variables

```bash
# Required
PRIVATE_KEY=your_private_key
FUNDER_ADDRESS=your_polymarket_profile_address

# Optional API credentials (auto-derived if not set)
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASSPHRASE=

# Rebate Farmer Config
CAPITAL_USD=100
REBATE_POOL_PERCENT=1.0
MIN_EDGE_USD=0.01
MAX_UNREALIZED_LOSS_USD=20
MAX_EXPOSURE_USD=500
PANIC_TIME_SEC=60

# Imbalance Handling
IMBALANCE_HOLD_MS=5000        # Wait before selling imbalanced side (ms)
IMBALANCE_STOP_LOSS_PCT=0.15  # Stop loss at 15% of cost basis

# Spread Trader Config
MARGIN_FROM_MID=0.02
ORDER_SIZE_USD=50
MIN_SPREAD_TO_ENTER=0.02
TIME_TO_EXPIRE_SEC=120
MAX_LOSS_PCT=0.05
MAX_ACTIVE_POSITIONS=2
POLL_INTERVAL_MS=2000
ENABLE_BID_SIDE=true    # Buy both sides when bid sum < $1
ENABLE_ASK_SIDE=true    # Sell both sides when ask sum > $1
PRE_SPLIT_USD=100       # USDC to split for ASK inventory
```

---

## Development

```bash
npm run typecheck  # Type check
npm run build      # Compile TypeScript
npm run dev        # Run with tsx (no build needed)
```
