import test from 'node:test';
import assert from 'node:assert/strict';
import { MonteCarloEngine } from '../src/monteCarloEngine';
import { SimulationEngine } from '../src/simulationEngine';
import { ProfileValidationError, ProfileStore } from '../src/profileStore';
import { PropFirmProfile, RiskProfile } from '../src/types';
import { RawTrade } from '../src/tradeParser';
import { normalizeSanitizationConfig } from '../src/tradeSanitizer';

const risk: RiskProfile = {
  evaluationContracts: 1,
  fundedPrePayoutContracts: 1,
  fundedPostPayoutContracts: 1,
  pointValue: 1,
  commissions: 0,
  useSmartScaling: false
};

function baseProfile(overrides: Partial<PropFirmProfile> = {}): PropFirmProfile {
  const profile: PropFirmProfile = {
    firm_name: 'Test 50K',
    account_size: 50000,
    cost: 0,
    version: 1,
    official: false,
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 300 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    fundedRules: {
      maxContracts: 10,
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: false,
      minPayoutAmount: 1,
      payoutSplit: 1,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  };
  return mergeProfile(profile, overrides);
}

function mergeProfile(profile: PropFirmProfile, overrides: Partial<PropFirmProfile>): PropFirmProfile {
  return {
    ...profile,
    ...overrides,
    evalRules: { ...profile.evalRules, ...overrides.evalRules },
    fundedRules: { ...profile.fundedRules, ...overrides.fundedRules },
    payoutRules: { ...profile.payoutRules, ...overrides.payoutRules }
  };
}

function trade(index: number, points: number): RawTrade {
  const day = String(index + 1).padStart(2, '0');
  const openTime = new Date(`2026-01-${day}T14:00:00Z`);
  const closeTime = new Date(`2026-01-${day}T14:15:00Z`);
  return {
    ticket: `${index}`,
    symbol: 'NQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime,
    closeTime,
    size: 1,
    rawPnl: points,
    netPoints: points
  };
}

test('records EVAL_PASSED on the trade that reaches target', () => {
  const profile = baseProfile();
  const trades = [trade(0, 100), trade(1, 100), trade(2, 50), trade(3, 50)];
  const result = new SimulationEngine(profile, risk, trades, 1, true).run();

  assert.equal(result.metrics.status, 'FUNDED');
  assert.equal(result.metrics.evalTrades, 4);
  const passTrade = result.trace?.trades.find(item => item.events.some(event => event.type === 'EVAL_PASSED'));
  assert.equal(passTrade?.index, 4);
});

test('records ACCOUNT_BLOWN when drawdown is touched', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1000 },
      drawdown: { enabled: true, mode: 'INTRADAY', amount: 100 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    }
  });
  const result = new SimulationEngine(profile, risk, [trade(0, -101)], 1, true).run();

  assert.equal(result.metrics.status, 'BLOWN');
  assert.ok(result.trace?.trades[0].events.some(event => event.type === 'ACCOUNT_BLOWN'));
});

test('blocks payout with consistency, then allows payout after dilution', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1 },
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
      resetCycleAfterPayout: true,
      consistency: { enabled: true, maxDailyProfitPercent: 0.5 }
    }
  });
  const result = new SimulationEngine(profile, risk, [trade(0, 1), trade(1, 100), trade(2, 100)], 1, true).run();
  const events = result.trace?.trades.flatMap(item => item.events.map(event => event.type)) || [];

  assert.ok(events.includes('CONSISTENCY_BLOCKED'));
  assert.ok(events.includes('PAYOUT_TAKEN'));
  assert.equal(result.metrics.payoutsTaken, 1);
});

test('seeded Monte Carlo is reproducible and seed changes the trace', () => {
  const profile = baseProfile();
  const trades = [100, -50, 75, -25, 150, -80, 40, 90].map((points, index) => trade(index, points));
  const first = new MonteCarloEngine(profile, risk, trades, 20, { mode: 'seeded', seed: 'same' }).runWithTraces(2);
  const second = new MonteCarloEngine(profile, risk, trades, 20, { mode: 'seeded', seed: 'same' }).runWithTraces(2);
  const third = new MonteCarloEngine(profile, risk, trades, 20, { mode: 'seeded', seed: 'different' }).runWithTraces(2);

  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.traces[0].trades.map(item => item.netPnl), second.traces[0].trades.map(item => item.netPnl));
  assert.notDeepEqual(first.traces[0].trades.map(item => item.netPnl), third.traces[0].trades.map(item => item.netPnl));
});

test('profile validation rejects invalid percentages', () => {
  const store = new ProfileStore('unused');
  const invalid = baseProfile({
    payoutRules: {
      enabled: true,
      minPayoutAmount: 1,
      payoutSplit: 1.4,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  });

  assert.throws(() => store.validate(invalid), ProfileValidationError);
});

test('uses different point values for evaluation and funded phases', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 20 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    }
  });
  const phaseRisk: RiskProfile = {
    evaluation: { instrument: 'NQ', contracts: 1, pointValue: 20 },
    fundedPrePayout: { instrument: 'MNQ', contracts: 1, pointValue: 2 },
    fundedPostPayout: { instrument: 'MNQ', contracts: 1, pointValue: 2 },
    commissions: 0,
    useSmartScaling: false
  };
  const result = new SimulationEngine(profile, phaseRisk, [trade(0, 1), trade(1, 10)], 1, true).run();
  const evalTrade = result.trace?.trades[0];
  const fundedTrade = result.trace?.trades[1];

  assert.equal(evalTrade?.instrument, 'NQ');
  assert.equal(evalTrade?.netPnl, 20);
  assert.equal(fundedTrade?.instrument, 'MNQ');
  assert.equal(fundedTrade?.netPnl, 20);
  assert.equal(fundedTrade?.pointValue, 2);
});

test('applies fixed TP SL independently for evaluation and funded phases', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 10 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    }
  });
  const phaseRisk: RiskProfile = {
    evaluation: { instrument: 'MNQ', contracts: 10, pointValue: 2 },
    fundedPrePayout: { instrument: 'MNQ', contracts: 6, pointValue: 2 },
    fundedPostPayout: { instrument: 'MNQ', contracts: 6, pointValue: 2 },
    commissions: 0,
    useSmartScaling: false
  };
  const sanitization = normalizeSanitizationConfig({
    mode: 'fixedOutcome',
    evaluation: { maxWinPoints: 82.5, maxLossPoints: 82.5 },
    funded: { maxWinPoints: 25, maxLossPoints: 50 }
  });
  const result = new SimulationEngine(profile, phaseRisk, [trade(0, 6.5), trade(1, 130), trade(2, -17)], 1, true, undefined, sanitization).run();

  assert.equal(result.trace?.trades[0].phase, 'evaluation');
  assert.equal(result.trace?.trades[0].netPoints, 82.5);
  assert.equal(result.trace?.trades[0].netPnl, 1650);
  assert.equal(result.trace?.trades[1].phase, 'funded');
  assert.equal(result.trace?.trades[1].netPoints, 25);
  assert.equal(result.trace?.trades[1].netPnl, 300);
  assert.equal(result.trace?.trades[2].netPoints, -50);
  assert.equal(result.trace?.trades[2].netPnl, -600);
});

test('can run evaluation and funded from separate trade samples', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    }
  });
  const phaseRisk: RiskProfile = {
    evaluation: { instrument: 'MNQ', contracts: 1, pointValue: 2 },
    fundedPrePayout: { instrument: 'MNQ', contracts: 1, pointValue: 2 },
    fundedPostPayout: { instrument: 'MNQ', contracts: 1, pointValue: 2 },
    commissions: 0,
    useSmartScaling: false
  };
  const result = new SimulationEngine(
    profile,
    phaseRisk,
    [trade(0, 1)],
    1,
    true,
    undefined,
    undefined,
    [trade(1, 25)]
  ).run();

  assert.equal(result.metrics.evalTrades, 1);
  assert.equal(result.metrics.fundedTrades, 1);
  assert.equal(result.trace?.trades[0].phase, 'evaluation');
  assert.equal(result.trace?.trades[1].phase, 'funded');
  assert.equal(result.trace?.trades[1].netPnl, 50);
});

test('allows micro contracts up to the mini-equivalent profile limit', () => {
  const profile = baseProfile({
    fundedRules: {
      maxContracts: 4,
      maxMiniContracts: 4,
      maxMicroContracts: 25,
      drawdown: { enabled: true, mode: 'EOD', amount: 10000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 },
      scaling: {
        enabled: true,
        updateTiming: 'EOD',
        allowDecrease: true,
        tiers: [{ profitFrom: 0, contracts: 4 }]
      }
    },
    evalRules: {
      maxContracts: 4,
      profitTarget: { enabled: true, amount: 20 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    }
  });
  const phaseRisk: RiskProfile = {
    evaluation: { instrument: 'NQ', contracts: 1, pointValue: 20 },
    fundedPrePayout: { instrument: 'MNQ', contracts: 30, pointValue: 2 },
    fundedPostPayout: { instrument: 'MNQ', contracts: 30, pointValue: 2 },
    commissions: 0,
    useSmartScaling: false
  };

  const result = new SimulationEngine(profile, phaseRisk, [trade(0, 1), trade(1, 1)], 1, true).run();
  const fundedTrade = result.trace?.trades[1];

  assert.equal(fundedTrade?.requestedContracts, 30);
  assert.equal(fundedTrade?.executedContracts, 25);
  assert.equal(fundedTrade?.netPnl, 50);
});

test('funded tactical payout trade unlocks payout on the next day', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: true,
      minTradingDays: 2,
      minProfitPerDay: 150,
      minPayoutAmount: 300,
      maxPayoutAmount: 300,
      payoutPercent: 1,
      payoutSplit: 1,
      positiveCycleProfitRequired: true,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  });
  const tacticalRisk: RiskProfile = {
    ...risk,
    useFundedTacticalPayoutTrade: true,
    tacticalPayoutWinRate: 1,
    tacticalPayoutRiskReward: 4
  };
  const result = new SimulationEngine(profile, tacticalRisk, [trade(0, 1), trade(1, 150), trade(2, 999)], 1, true).run();
  const synthetic = result.trace?.trades.find(item => item.isSynthetic);
  const events = result.trace?.trades.flatMap(item => item.events.map(event => event.type)) || [];

  assert.equal(result.metrics.payoutsTaken, 1);
  assert.equal(result.metrics.tacticalTrades, 1);
  assert.equal(result.metrics.tacticalWins, 1);
  assert.equal(result.metrics.payoutsUnlockedByTactical, 1);
  assert.equal(synthetic?.netPnl, 150);
  assert.equal(synthetic?.rewardAmount, 150);
  assert.equal(synthetic?.riskAmount, 600);
  assert.ok(events.includes('TACTICAL_PAYOUT_TRADE_SCHEDULED'));
  assert.ok(events.includes('TACTICAL_PAYOUT_TRADE_WON'));
  assert.ok(events.includes('TACTICAL_PAYOUT_UNLOCKED'));
});

test('funded tactical payout trade does not run unless winning unlocks payout', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: true,
      minTradingDays: 3,
      minProfitPerDay: 150,
      minPayoutAmount: 300,
      maxPayoutAmount: 300,
      payoutPercent: 1,
      payoutSplit: 1,
      positiveCycleProfitRequired: true,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  });
  const tacticalRisk: RiskProfile = {
    ...risk,
    useFundedTacticalPayoutTrade: true,
    tacticalPayoutWinRate: 1,
    tacticalPayoutRiskReward: 4
  };
  const result = new SimulationEngine(profile, tacticalRisk, [trade(0, 1), trade(1, 150), trade(2, 999)], 1, true).run();

  assert.equal(result.metrics.tacticalTrades, 0);
  assert.equal(result.trace?.trades.some(item => item.isSynthetic), false);
});

test('losing funded tactical payout trade can blow the account', () => {
  const profile = baseProfile({
    evalRules: {
      maxContracts: 10,
      profitTarget: { enabled: true, amount: 1 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    fundedRules: {
      maxContracts: 10,
      drawdown: { enabled: true, mode: 'EOD', amount: 500 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: true,
      minTradingDays: 2,
      minProfitPerDay: 200,
      minPayoutAmount: 400,
      maxPayoutAmount: 400,
      payoutPercent: 1,
      payoutSplit: 1,
      positiveCycleProfitRequired: true,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  });
  const tacticalRisk: RiskProfile = {
    ...risk,
    useFundedTacticalPayoutTrade: true,
    tacticalPayoutWinRate: 0,
    tacticalPayoutRiskReward: 4
  };
  const result = new SimulationEngine(profile, tacticalRisk, [trade(0, 1), trade(1, 200), trade(2, 999)], 1, true).run();
  const synthetic = result.trace?.trades.find(item => item.isSynthetic);

  assert.equal(result.metrics.status, 'BLOWN');
  assert.equal(result.metrics.tacticalTrades, 1);
  assert.equal(result.metrics.accountsBlownByTactical, 1);
  assert.equal(synthetic?.netPnl, -800);
  assert.ok(synthetic?.events.some(event => event.type === 'TACTICAL_PAYOUT_TRADE_LOST'));
  assert.ok(synthetic?.events.some(event => event.type === 'ACCOUNT_BLOWN'));
});
