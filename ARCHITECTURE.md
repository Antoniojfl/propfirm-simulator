# Prop Firm Simulator - Architectural Documentation

**Author:** Antigravity AI (Senior Software Architect)
**Purpose:** Provide comprehensive context for future AIs or developers to understand, maintain, and scale the Monte Carlo Prop Firm Simulation Engine.

---

## 1. System Overview

This system is a **Monte Carlo Simulation Engine** designed to evaluate algorithmic trading strategies against the specific rules of proprietary trading firms (Prop Firms). 

Instead of relying on a single deterministic backtest, it takes raw trade data (exported from StrategyQuant X), shuffles the order of trades randomly (Resampling with Replacement), and simulates thousands of parallel universes. This provides a robust statistical probability of passing an evaluation, surviving the funded phase, and achieving payouts.

### Tech Stack
- **Backend:** Node.js, Express, TypeScript.
- **Frontend:** HTML, Vanilla CSS, Vanilla JavaScript.
- **Input:** CSV files from StrategyQuant X (`src/tradeParser.ts`).

---

## 2. Core Architecture & Data Flow

The application follows a modular, decoupled architecture centered around the Strategy Pattern for business logic.

### Request Flow
1. **Frontend (`public/index.html`)**: User selects a Prop Firm Profile (JSON), a folder of CSV strategies, and risk parameters (Contracts, Commissions, Smart Scaling).
2. **API Endpoint (`src/server.ts`)**: Receives the request, parses the Prop Firm JSON, reads the CSVs, and spawns a `MonteCarloEngine` for each strategy.
3. **Monte Carlo Loop (`src/monteCarloEngine.ts`)**: Iterates $N$ times (default: 1000). For each iteration, it shuffles the raw trades and spins up a `SimulationEngine`.
4. **Simulation Core (`src/simulationEngine.ts`)**: Manages the lifecycle of an `Account`. First, it tries to pass the **Evaluation Phase**. If successful, it graduates the account and runs the **Funded Phase** until it blows up or hits a payout graduation limit.
5. **State Management (`src/account.ts`)**: The `Account` class maintains the balance, drawdown, High Water Mark (HWM), and processes individual trades (calculating gross/net PnL based on lot sizes and commissions).
6. **Prop Firm Rules (`src/firmRules/*`)**: The `Account` delegates all firm-specific business logic (Drawdown rules, Payout rules, Consistency rules) to a dedicated `FirmRules` class via the Strategy Pattern.

---

## 3. The Strategy Pattern: `FirmRules`

To prevent massive `if/else` blocks when dealing with different Prop Firms (e.g., Apex, Lucid, Topstep), the system uses a **Strategy Pattern**.

### `src/firmRules/FirmRules.ts`
The interface that every Prop Firm rule engine must implement:
*   `checkPayoutEligibility(account, profile)`: Determines if the funded account has met the criteria to withdraw money, and returns the payout amount.
*   `updateHighWaterMark(account, balance, profile)`: Handles the specific Trailing Drawdown or End Of Day (EOD) logic.
*   `checkConsistencyRule(account, profile)`: Validates if the best trading day violates the maximum allowed percentage of total profits.

### Implementations:
*   **`ApexRules.ts`**: Implements traditional real-time Trailing Drawdown, Fixed Payouts, and "Buffer" requirements (must build a safety cushion before withdrawing).
*   **`LucidRules.ts`**: Implements Bufferless logic. Allows withdrawal of a percentage of profits (e.g., 50%) after a specific number of profitable days (e.g., 5 days > $150).

### `RuleFactory.ts`
Reads the `rule_engine` property from the JSON profile (e.g., `"rule_engine": "LUCID"`) and injects the corresponding ruleset into the `Account` constructor.

> [!TIP]
> **How to add a new Prop Firm with unique rules:**
> 1. Create `NewFirmRules.ts` implementing `FirmRules`.
> 2. Add the instantiation logic in `RuleFactory.ts` (e.g., `if (profile.rule_engine === 'NEW_FIRM') return new NewFirmRules();`).
> 3. Create a JSON profile in `config/prop_firms/` with `"rule_engine": "NEW_FIRM"`.

---

## 4. Key Mechanisms

### A. Smart Lot Scaling (Auto De-risking)
Located in `Account.ts` (`processTrade`). When an Evaluation account gets extremely close to the Profit Target, trading full lot sizes is mathematically irresponsible (risk of blowing the account unnecessarily). 
If enabled, the engine calculates the remaining profit needed and dynamically **reduces the number of contracts** for the next trade to exactly match the target. This mathematically alters the `Avg Eval Win` and `Avg Eval Loss` metrics in the final output.

### B. Monte Carlo Resampling
Located in `MonteCarloEngine.ts` (`resampleTrades`). It uses random sampling **with replacement** from the original strategy's trade pool. This ensures that the sequence risk (e.g., 5 losses in a row) is thoroughly stress-tested.

### C. Lifespan Calculation
Because Monte Carlo scrambles chronological dates, we cannot use `Date` objects to calculate how long an account survived. Instead, `monteCarloEngine.ts` calculates the `avgTradesPerDay` from the raw chronological CSV. 
The `Lifespan` of a funded account is then mathematically derived: `Total Funded Trades / avgTradesPerDay`.

---

## 5. Extensibility Guide for Future AIs

When modifying this system, adhere to these architectural boundaries:

1.  **Do NOT put business rules in `Account.ts` or `SimulationEngine.ts`.** If a prop firm introduces a new rule (e.g., "Max Drawdown resets at $50,000"), handle it inside the specific `firmRules/` implementation file.
2.  **Updating Metrics:** If you need to show new statistical data in the UI:
    *   Aggregate the raw variable in the loop inside `SimulationEngine.ts`.
    *   Push the array of results to `MonteCarloEngine.ts`.
    *   Calculate the Average/Median in `MonteCarloEngine.ts` and add it to `MonteCarloResults` interface.
    *   Update `public/index.html` to render the column.
3.  **Risk Configurations:** Anything related to commissions, friction, point values, or contract sizes per phase is managed by `RiskManager.ts`. Do not hardcode `$20` for NQ points in the rules; always call `riskManager.getPointValue()`.

## 6. Known Limitations
- The engine uses trade-level resolution (Closed PnL). It does not process tick-level data (MFE/MAE). Therefore, "Intraday Trailing Drawdowns" are simulated at the close of each trade, not at the absolute peak of unrealized profit. This is generally acceptable but creates a slight margin of error compared to live markets.
