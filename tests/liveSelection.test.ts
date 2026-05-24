import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTrade } from '../src/tradeParser';
import { filterTradesByRange } from '../src/liveSelection/periodSplitter';
import { buildYearlyMatrix } from '../src/liveSelection/yearlyMatrix';
import { evaluateStrategy } from '../src/liveSelection/strategyEvaluator';
import { buildLiveSelectionPortfolio } from '../src/liveSelection/portfolioBuilder';
import { LiveSelectionConfig, LiveSelectionEvaluation } from '../src/liveSelection/types';
import { MonteCarloResults } from '../src/monteCarloEngine';

test('periodSplitter separates 2015-2022 from recent trades', () => {
  const trades = [trade(2015, 10), trade(2022, -10), trade(2023, 10), trade(2026, 10)];
  assert.equal(filterTradesByRange(trades, { start: 2015, end: 2022 }).length, 2);
  assert.equal(filterTradesByRange(trades, { start: 2023, end: 2026 }).length, 2);
});

test('yearly matrix marks low-sample years', () => {
  const rows = buildYearlyMatrix([trade(2015, 10), trade(2015, -10)], { start: 2015, end: 2015 }, 3);
  assert.equal(rows[0].verdict, 'LOW_SAMPLE');
});

test('strategy evaluator rejects insufficient total and OOS samples', () => {
  const config = testConfig();
  const insufficientTotal = evaluateStrategy({
    totalTrades: 4,
    oosTrades: 4,
    yearlyMatrix: passYears(),
    oosMetrics: metric({ expectedValue: 1000 }),
    config
  });
  assert.equal(insufficientTotal.status, 'REJECT');

  const insufficientOos = evaluateStrategy({
    totalTrades: 20,
    oosTrades: 4,
    yearlyMatrix: passYears(),
    oosMetrics: metric({ expectedValue: 1000 }),
    config
  });
  assert.equal(insufficientOos.status, 'REJECT');
});

test('strategy evaluator requires OOS yearly majority', () => {
  const decision = evaluateStrategy({
    totalTrades: 20,
    oosTrades: 20,
    yearlyMatrix: [
      ...passYears().slice(0, 2),
      { ...passYears()[0], year: 2017, verdict: 'FAIL' },
      { ...passYears()[0], year: 2018, verdict: 'FAIL' }
    ],
    oosMetrics: metric({ expectedValue: 1000, payoutRatePercent: 50 }),
    config: testConfig()
  });
  assert.equal(decision.status, 'REJECT');
});

test('EV per day can outrank higher raw EV', () => {
  const fast = evaluateStrategy({
    totalTrades: 20,
    oosTrades: 20,
    yearlyMatrix: passYears(),
    oosMetrics: metric({ expectedValue: 800, avgDaysToPass: 4, medianFundedLifespanDays: 4 }),
    config: testConfig()
  });
  const slow = evaluateStrategy({
    totalTrades: 20,
    oosTrades: 20,
    yearlyMatrix: passYears(),
    oosMetrics: metric({ expectedValue: 1200, avgDaysToPass: 20, medianFundedLifespanDays: 20 }),
    config: testConfig()
  });
  assert.equal(fast.status, 'LIVE_CANDIDATE');
  assert.ok(fast.liveScore > slow.liveScore);
});

test('live selection portfolio penalizes absolute correlation', () => {
  const duplicate = evaluation('duplicate.csv', 980, [1, -1, 1, -1, 1, -1]);
  const diversifier = evaluation('diversifier.csv', 900, [1, 1, -1, 1, 1, -1]);
  const result = buildLiveSelectionPortfolio({
    candidates: [
      evaluation('best.csv', 1000, [1, -1, 1, -1, 1, -1]),
      duplicate,
      diversifier
    ],
    portfolioSize: 2,
    diversityWeight: 0.8,
    minOverlapDays: 6
  });
  assert.equal(result.portfolio[0].strategy, 'best.csv');
  assert.equal(result.portfolio[1].strategy, 'diversifier.csv');
  assert.equal(result.nearMisses[0].strategy, 'duplicate.csv');
});

function testConfig(): LiveSelectionConfig {
  return {
    oosRange: { start: 2015, end: 2018 },
    recentRange: { start: 2023, end: 2026 },
    portfolioSize: 5,
    diversityWeight: 0.35,
    minTotalTrades: 10,
    minOosTrades: 10,
    minTradesPerYear: 1,
    minOosPassingYears: 3,
    maxOosFailYears: 1,
    iterations: 100
  };
}

function passYears() {
  return [2015, 2016, 2017, 2018].map(year => ({
    year,
    trades: 10,
    netPoints: 100,
    winRatePercent: 55,
    profitFactor: 1.2,
    maxConsecutiveLosses: 3,
    expectancyPoints: 10,
    verdict: 'PASS' as const
  }));
}

function evaluation(name: string, liveScore: number, daily: number[]): LiveSelectionEvaluation {
  return {
    strategy: name,
    status: 'LIVE_CANDIDATE',
    liveScore,
    adjustedScore: liveScore,
    evPerDay: liveScore / 10,
    avgCorrelation: 0,
    totalTrades: 100,
    oosTrades: 80,
    oosPassYears: 4,
    oosWeakYears: 0,
    oosFailYears: 0,
    oosLowSampleYears: 0,
    yearlyMatrix: passYears(),
    oos: { trades: 80, monteCarlo: metric({ expectedValue: liveScore }) },
    recent: { trades: 20, monteCarlo: metric({ expectedValue: liveScore }) },
    full: { trades: 100, monteCarlo: metric({ expectedValue: liveScore }) },
    dailySeries: daily.map((pnl, index) => ({ date: `2020-01-${String(index + 1).padStart(2, '0')}`, pnl })),
    reasons: [],
    warnings: []
  };
}

function trade(year: number, points: number): RawTrade {
  return {
    ticket: `${year}-${points}`,
    symbol: 'NQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime: new Date(`${year}-01-01T14:00:00Z`),
    closeTime: new Date(`${year}-01-01T14:15:00Z`),
    size: 1,
    rawPnl: points,
    netPoints: points
  };
}

function metric(overrides: Partial<MonteCarloResults>): MonteCarloResults {
  return {
    firmName: 'x',
    iterations: 100,
    evalPassed: 0,
    evalBlown: 0,
    fundedAccounts: 0,
    fundedAccountsWithPayout: 0,
    avgPayoutPerAccount: 0,
    expectedValue: 1000,
    passRatePercent: 80,
    payoutRatePercent: 50,
    avgDaysToPass: 10,
    medianFundedLifespanDays: 10,
    accountCycleDays: 20,
    expectedValuePerDay: 50,
    expectedValuePer30Days: 1500,
    medianMonthlyReturn: 0,
    medianMaxConsecutiveLosses: 3,
    avgProfitFactor: 1.1,
    percentAccounts3PlusPayouts: 20,
    fundedBlowUpRate: 20,
    medianPayoutPerAccount: 0,
    avgWinRate: 0,
    avgNetPerTrade: 0,
    medianTradesToPass: 0,
    medianTradesToBlowEval: 0,
    medianFundedTrades: 0,
    avgEvalWin: 0,
    avgEvalLoss: 0,
    avgFundedWin: 0,
    avgFundedLoss: 0,
    avgPayoutsCount: 0,
    avgSinglePayoutAmount: 0,
    maxPayouts: 0,
    avgTacticalTrades: 0,
    tacticalWinRateRealized: 0,
    avgTacticalPnL: 0,
    payoutsUnlockedByTactical: 0,
    accountsBlownByTactical: 0,
    randomization: { mode: 'seeded', seed: 'test' },
    ...overrides
  };
}
