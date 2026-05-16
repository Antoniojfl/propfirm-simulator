import test from 'node:test';
import assert from 'node:assert/strict';
import { pearsonCorrelation } from '../src/live/correlation';
import { buildLivePortfolio } from '../src/live/portfolioSelector';
import { DailyPnlPoint, LiveStrategyInput } from '../src/live/types';
import { MonteCarloResults } from '../src/monteCarloEngine';

function series(values: number[], startDay = 1): DailyPnlPoint[] {
  return values.map((pnl, index) => ({
    date: `2026-01-${String(startDay + index).padStart(2, '0')}`,
    pnl
  }));
}

function strategy(name: string, expectedValue: number, daily: number[]): LiveStrategyInput {
  return {
    strategy: name,
    dailySeries: series(daily),
    metrics: metric({
      expectedValue,
      passRatePercent: 80,
      payoutRatePercent: 60,
      fundedBlowUpRate: 10,
      medianMaxConsecutiveLosses: 3,
      percentAccounts3PlusPayouts: 30
    })
  };
}

test('live correlation treats positive and negative perfect correlation as absolute risk', () => {
  const base = series([1, 2, 3, 4, 5]);
  const same = series([2, 4, 6, 8, 10]);
  const inverse = series([-2, -4, -6, -8, -10]);

  assert.equal(Math.abs(pearsonCorrelation(base, same, 5).correlation!), 1);
  assert.equal(Math.abs(pearsonCorrelation(base, inverse, 5).correlation!), 1);
});

test('live correlation marks insufficient overlap without a numeric penalty', () => {
  const result = pearsonCorrelation(series([1, 2, 3]), series([1, 2, 3], 10), 3);

  assert.equal(result.correlation, null);
  assert.equal(result.insufficientOverlap, true);
});

test('live portfolio selects top N and penalizes highly correlated strategies', () => {
  const base = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? 10 : -5);
  const duplicate = base.map(value => value * 2);
  const diversifier = Array.from({ length: 40 }, (_, index) => index % 3 === 0 ? -3 : 6);
  const result = buildLivePortfolio({
    strategies: [
      strategy('best.csv', 1000, base),
      strategy('duplicate.csv', 980, duplicate),
      strategy('diversifier.csv', 900, diversifier)
    ],
    topN: 2,
    diversityWeight: 0.8,
    minOverlapDays: 30
  });

  assert.equal(result.portfolio.length, 2);
  assert.equal(result.portfolio[0].strategy, 'best.csv');
  assert.equal(result.portfolio[1].strategy, 'diversifier.csv');
  assert.equal(result.nearMisses[0].strategy, 'duplicate.csv');
});

function metric(overrides: Partial<MonteCarloResults>): MonteCarloResults {
  return {
    firmName: 'x',
    iterations: 1000,
    evalPassed: 0,
    evalBlown: 0,
    fundedAccounts: 0,
    fundedAccountsWithPayout: 0,
    avgPayoutPerAccount: 0,
    expectedValue: 0,
    passRatePercent: 0,
    payoutRatePercent: 0,
    avgDaysToPass: 10,
    medianFundedLifespanDays: 0,
    medianMonthlyReturn: 0,
    medianMaxConsecutiveLosses: 0,
    avgProfitFactor: 0,
    percentAccounts3PlusPayouts: 0,
    fundedBlowUpRate: 0,
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
    randomization: { mode: 'seeded', seed: 'x' },
    ...overrides
  };
}
