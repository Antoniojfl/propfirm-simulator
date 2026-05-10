import test from 'node:test';
import assert from 'node:assert/strict';
import { BankrollEngine } from '../src/bankroll/bankrollEngine';
import { BankrollRequest } from '../src/bankroll/types';
import { PropFirmProfile, RiskProfile } from '../src/types';
import { RawTrade } from '../src/tradeParser';

function profile(cost = 10): PropFirmProfile {
  return {
    firm_name: 'Bankroll Test',
    account_size: 50000,
    cost,
    version: 1,
    official: false,
    evalRules: {
      maxContracts: 1,
      maxMiniContracts: 1,
      maxMicroContracts: 10,
      profitTarget: { enabled: true, amount: 20 },
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    fundedRules: {
      maxContracts: 1,
      maxMiniContracts: 1,
      maxMicroContracts: 10,
      drawdown: { enabled: true, mode: 'EOD', amount: 1000 },
      consistency: { enabled: false, maxDailyProfitPercent: 0 },
      minTradingDays: { enabled: false, days: 0 }
    },
    payoutRules: {
      enabled: true,
      minTradingDays: 1,
      minProfitPerDay: 1,
      minPayoutAmount: 1,
      payoutPercent: 1,
      payoutSplit: 1,
      positiveCycleProfitRequired: true,
      deductPayout: true,
      resetCycleAfterPayout: true
    }
  };
}

const risk: RiskProfile = {
  evaluation: { instrument: 'NQ', contracts: 1, pointValue: 20 },
  fundedPrePayout: { instrument: 'NQ', contracts: 1, pointValue: 20 },
  fundedPostPayout: { instrument: 'NQ', contracts: 1, pointValue: 20 },
  commissions: 0,
  useSmartScaling: false
};

function trade(index: number, points: number): RawTrade {
  const day = String(index + 1).padStart(2, '0');
  return {
    ticket: `${index}`,
    symbol: 'NQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime: new Date(`2026-01-${day}T14:00:00Z`),
    closeTime: new Date(`2026-01-${day}T14:15:00Z`),
    size: 1,
    rawPnl: points,
    netPoints: points
  };
}

function request(overrides: Partial<BankrollRequest> = {}): BankrollRequest {
  return {
    initialBankroll: 100,
    maxActiveAccountsPerDay: 1,
    horizonMonths: 1,
    iterations: 1,
    reinvestmentPercent: 1,
    randomization: { mode: 'seeded', seed: 'bankroll-test' },
    ...overrides
  };
}

test('bankroll deducts account cost when buying evaluations', () => {
  const result = new BankrollEngine({
    profile: profile(10),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, -100)] }],
    request: request({ initialBankroll: 100, horizonMonths: 1 })
  }).run();

  const purchase = result.eventSamples.find(event => event.type === 'ACCOUNT_PURCHASED');
  assert.equal(purchase?.amount, -10);
  assert.equal(purchase?.bankrollAfter, 90);
});

test('bankroll keeps no more than the configured active account slots', () => {
  const result = new BankrollEngine({
    profile: profile(10),
    riskProfile: risk,
    strategies: [
      { strategy: 'a.csv', trades: [trade(0, 1), trade(1, 1)] },
      { strategy: 'b.csv', trades: [trade(0, 1), trade(1, 1)] },
      { strategy: 'c.csv', trades: [trade(0, 1), trade(1, 1)] }
    ],
    request: request({ maxActiveAccountsPerDay: 2, horizonMonths: 1 })
  }).run();

  const maxActive = Math.max(...result.representativeCurves[0].curve.map(point => point.activeAccounts));
  assert.equal(maxActive, 2);
});

test('bankroll reinvests only the configured payout percentage', () => {
  const result = new BankrollEngine({
    profile: profile(10),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, 1), trade(1, 1)] }],
    request: request({ initialBankroll: 100, reinvestmentPercent: 0.5, horizonMonths: 1 })
  }).run();

  const payout = result.eventSamples.find(event => event.type === 'PAYOUT_TAKEN');
  assert.equal(payout?.amount, 10);
  assert.ok(result.avgWithdrawnProfit >= 10);
});

test('bankroll marks ruin and stalled states', () => {
  const ruined = new BankrollEngine({
    profile: profile(10),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, -100)] }],
    request: request({ initialBankroll: 10, horizonMonths: 1 })
  }).run();
  assert.equal(ruined.riskOfRuinPercent, 100);

  const stalled = new BankrollEngine({
    profile: profile(10),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [] }],
    request: request({ initialBankroll: 15, horizonMonths: 1 })
  }).run();
  assert.equal(stalled.stalledPercent, 100);
});

test('bankroll seeded runs are reproducible', () => {
  const input = {
    profile: profile(10),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, 1), trade(1, -5), trade(2, 2), trade(3, 3)] }],
    request: request({ iterations: 5, horizonMonths: 2, randomization: { mode: 'seeded' as const, seed: 'same-bankroll' } })
  };

  const first = new BankrollEngine(input).run();
  const second = new BankrollEngine(input).run();

  assert.deepEqual(first.representativeCurves, second.representativeCurves);
  assert.equal(first.medianFinalBankroll, second.medianFinalBankroll);
});
