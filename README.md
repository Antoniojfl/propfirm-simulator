# Prop Firm Account Simulator

> **Status: PENDING IMPLEMENTATION**

---

## Objective

Given a list of historical trades from one or more trading strategies (CSV/JSON),
simulate how those trades would perform against the evaluation rules of major
prop firm programs.

The goal is to answer: **"Would this strategy pass the evaluation — and stay funded?"**

---

## Planned Features

### Phase 1 — Core Simulation Engine

- Load trade list from CSV (compatible with NinjaTrader, StrategyQuant, MT5 exports)
- Simulate account balance curve trade by trade
- Track:
  - Daily P&L
  - Cumulative drawdown (from peak equity)
  - Trailing max drawdown (EOD or intraday)
  - Win rate, profit factor, average RR

### Phase 2 — Prop Firm Rule Engine

Configurable rules per firm:

| Rule | Description |
|---|---|
| `daily_loss_limit` | Max loss allowed in a single trading day |
| `max_trailing_drawdown` | Maximum drawdown from account peak (trailing or static) |
| `profit_target` | Required profit to pass evaluation |
| `min_trading_days` | Minimum number of active trading days |
| `max_daily_profit_cap` | Some firms cap how much you can make in one day (consistency rule) |
| `consistency_rule` | No single day > X% of total profit |
| `news_restriction` | Flag trades within N minutes of major news events |
| `time_restriction` | Flag trades outside allowed hours |
| `contract_limit` | Max contracts per trade |

### Phase 3 — Multi-Firm Comparison

Run the same strategy against multiple firm configurations simultaneously
and output a comparison table:

```
Strategy: NQ_scalper_v3
Trades: 847 | Period: 2024-01-01 to 2025-01-01

Firm                  | Pass/Fail | Violations | Max DD Hit | Days to Pass
----------------------|-----------|------------|------------|-------------
Apex $50K 1-Step      | PASS      | 0          | 62%        | 14 days
Apex $50K 2-Step      | PASS      | 0          | 71%        | 8 days
TopStep $50K          | FAIL      | 2          | 98%        | N/A
FTMO $100K            | FAIL      | 1          | 89%        | N/A
MyFundedFutures $50K  | PASS      | 0          | 55%        | 11 days
```

### Phase 4 — Monte Carlo Simulation

- Generate N random trade sequences from the strategy's distribution
- Simulate pass/fail probability across scenarios
- Confidence interval: "This strategy passes X% of the time"

---

## Input Format (Planned)

### Trade List CSV

```csv
date,time,symbol,direction,entry_price,exit_price,contracts,pnl,mae,mfe
2024-01-15,09:32:00,NQ,BUY,21050.25,21075.50,2,1012.50,-125.00,1350.00
2024-01-15,10:15:00,NQ,SELL,21082.00,21065.75,1,325.00,-200.00,500.00
```

### Firm Config JSON

```json
{
  "firm": "Apex Trader Funding",
  "account_size": 50000,
  "profit_target": 3000,
  "daily_loss_limit": 1000,
  "max_trailing_drawdown": 2500,
  "trailing_type": "EOD",
  "min_trading_days": 7,
  "consistency_rule": false,
  "contract_limit": 5
}
```

---

## Firms to Model (Initial Set)

- **Apex Trader Funding** — 1-step and 2-step programs, trailing EOD DD
- **TopStep** — 2-step, consistency rule, daily loss limit
- **FTMO** — 2-step, max daily loss + max overall loss
- **MyFundedFutures** — 1-step, static DD
- **Take Profit Trader** — EOD trailing DD

---

## Tech Stack (Proposed)

- **Runtime:** Node.js or Python (TBD based on user preference)
- **Input:** CSV trade list (NinjaTrader/MT5/SQX export format)
- **Output:** Console table + optional JSON/CSV report
- **Config:** JSON per firm (easily extensible)

---

## Source Data

The user has strategy trade lists from StrategyQuant X backtests.
Format will be confirmed when implementation begins.
