import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates } from '../src/optimizer/candidateGenerator';
import { scoreRiskAdjustedEV } from '../src/optimizer/scoring';
import { OptimizerEngine } from '../src/optimizer/optimizerEngine';
import { MonteCarloResults } from '../src/monteCarloEngine';
import { PropFirmProfile } from '../src/types';
import { RawTrade } from '../src/tradeParser';

function profile(): PropFirmProfile {
  return {
    firm_name: 'Optimizer Test',
    account_size: 50000,
    cost: 0,
    version: 1,
    official: false,
    evalRules: {
      maxContracts: 2,
      profitTarget: { enabled: true, amount: 200 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    fundedRules: {
      maxContracts: 2,
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: true,
      minTradingDays: 1,
      minProfitPerDay: 1,
      minPayoutAmount: 1,
      maxPayoutAmount: 1000,
      payoutPercent: 1,
      payoutSplit: 1,
      positiveCycleProfitRequired: true,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  };
}

function rawTrade(index: number, points: number): RawTrade {
  const day = String(index + 1).padStart(2, '0');
  return {
    ticket: String(index),
    symbol: 'NQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime: new Date(`2026-02-${day}T14:00:00Z`),
    closeTime: new Date(`2026-02-${day}T14:15:00Z`),
    size: 1,
    rawPnl: points,
    netPoints: points
  };
}

test('optimizer candidate generator stays inside requested ranges and profile limits', () => {
  const candidates = generateCandidates(profile(), {
    evaluation: { instruments: ['NQ'], contracts: { min: 1, max: 5 } },
    fundedPrePayout: { instruments: ['MNQ'], contracts: { min: 1, max: 5 } },
    fundedPostPayout: { instruments: ['MNQ'], contracts: { min: 1, max: 5 } },
    useSmartScaling: false
  });

  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(candidate => candidate.riskProfile.evaluation?.contracts! <= 2));
  assert.ok(candidates.every(candidate => candidate.riskProfile.fundedPrePayout?.instrument === 'MNQ'));
});

test('optimizer treats micro contract ranges as mini-equivalent limits', () => {
  const candidates = generateCandidates(profile(), {
    evaluation: { instruments: ['NQ'], contracts: { min: 1, max: 1 } },
    fundedPrePayout: { instruments: ['MNQ'], contracts: { min: 20, max: 25 } },
    fundedPostPayout: { instruments: ['MNQ'], contracts: { min: 20, max: 25 } },
    useSmartScaling: false
  });

  assert.ok(candidates.some(candidate => candidate.riskProfile.fundedPrePayout?.contracts === 20));
  assert.ok(candidates.every(candidate => candidate.riskProfile.fundedPrePayout?.contracts! <= 20));
});

test('optimizer respects explicit max micro contracts from profile', () => {
  const propProfile = profile();
  propProfile.fundedRules.maxMiniContracts = 2;
  propProfile.fundedRules.maxMicroContracts = 25;
  const candidates = generateCandidates(propProfile, {
    evaluation: { instruments: ['NQ'], contracts: { min: 1, max: 1 } },
    fundedPrePayout: { instruments: ['MNQ'], contracts: { min: 24, max: 30 } },
    fundedPostPayout: { instruments: ['MNQ'], contracts: { min: 24, max: 30 } },
    useSmartScaling: false
  });

  assert.ok(candidates.some(candidate => candidate.riskProfile.fundedPrePayout?.contracts === 25));
  assert.ok(candidates.every(candidate => candidate.riskProfile.fundedPrePayout?.contracts! <= 25));
});

test('risk-adjusted score penalizes fragile high-EV configurations', () => {
  const stable = metric({ expectedValue: 800, passRatePercent: 80, payoutRatePercent: 60, fundedBlowUpRate: 10, medianMaxConsecutiveLosses: 3 });
  const fragile = metric({ expectedValue: 1200, passRatePercent: 30, payoutRatePercent: 20, fundedBlowUpRate: 80, medianMaxConsecutiveLosses: 10 });

  assert.ok(scoreRiskAdjustedEV(stable) > scoreRiskAdjustedEV(fragile));
});

test('optimizer is reproducible with the same seed', () => {
  const trades = [10, -5, 20, 15, -10, 30, 5, -5].map((points, index) => rawTrade(index, points));
  const input = {
    profile: profile(),
    strategies: [{ strategy: 'sample.csv', trades }],
    request: {
      iterations: 20,
      randomization: { mode: 'seeded' as const, seed: 'opt-seed' },
      evaluation: { instruments: ['NQ' as const], contracts: { min: 1, max: 2 } },
      fundedPrePayout: { instruments: ['MNQ' as const], contracts: { min: 1, max: 1 } },
      fundedPostPayout: { instruments: ['MNQ' as const], contracts: { min: 1, max: 1 } },
      useSmartScaling: false,
      maxCandidates: 5
    }
  };

  const first = new OptimizerEngine(input).run();
  const second = new OptimizerEngine(input).run();
  assert.deepEqual(first.results.map(row => [row.candidate.id, row.score]), second.results.map(row => [row.candidate.id, row.score]));
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
    accountCycleDays: 10,
    expectedValuePerDay: 0,
    expectedValuePer30Days: 0,
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
