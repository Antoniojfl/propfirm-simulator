import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoricalReplayEngine } from '../src/historicalReplay/historicalReplayEngine';
import { PropFirmProfile, RiskProfile } from '../src/types';
import { RawTrade } from '../src/tradeParser';

function profile(cost = 10): PropFirmProfile {
  return {
    firm_name: 'Historical Replay Test',
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

test('historical replay replaces blown accounts on the same day and advances original trades', () => {
  const result = new HistoricalReplayEngine({
    profile: profile(99),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, -100), trade(1, -100), trade(2, -100)] }],
    request: {
      initialBankroll: 40,
      maxActiveAccounts: 1,
      accountCost: 10,
      horizonDays: 10,
      reinvestmentPercent: 1
    }
  }).run();

  const blownEvents = result.eventTimeline.filter(event => event.type === 'ACCOUNT_BLOWN');
  const purchaseEvents = result.eventTimeline.filter(event => event.type === 'ACCOUNT_PURCHASED');
  const firstBlownIndex = result.eventTimeline.findIndex(event => event.type === 'ACCOUNT_BLOWN');
  const replacement = result.eventTimeline[firstBlownIndex + 1];

  assert.equal(result.accountsPurchased, 3);
  assert.equal(result.accountsBlown, 3);
  assert.equal(result.accountCostTotal, 30);
  assert.equal(blownEvents.length, 3);
  assert.equal(purchaseEvents.length, 3);
  assert.equal(replacement.type, 'ACCOUNT_PURCHASED');
  assert.equal(replacement.day, blownEvents[0].day);
});

test('historical replay tracks payouts, withdrawn profit, and net profit', () => {
  const result = new HistoricalReplayEngine({
    profile: profile(0),
    riskProfile: risk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, 1)], fundedTrades: [trade(1, 1)] }],
    request: {
      initialBankroll: 100,
      maxActiveAccounts: 1,
      horizonDays: 2,
      reinvestmentPercent: 0.5
    }
  }).run();

  assert.equal(result.payoutsTaken, 1);
  assert.equal(result.grossPayouts, 20);
  assert.equal(result.withdrawnProfit, 10);
  assert.equal(result.cashBalance, 110);
  assert.equal(result.netProfit, 20);
});

test('historical replay calculates PnL from trade sign and phase inputs only', () => {
  const replayProfile = profile(0);
  replayProfile.evalRules.profitTarget.amount = 10000;
  replayProfile.evalRules.drawdown.amount = 10000;
  replayProfile.fundedRules.drawdown.amount = 10000;

  const mnqRisk: RiskProfile = {
    evaluation: { instrument: 'MNQ', contracts: 2, pointValue: 2 },
    fundedPrePayout: { instrument: 'MNQ', contracts: 2, pointValue: 2 },
    fundedPostPayout: { instrument: 'MNQ', contracts: 2, pointValue: 2 },
    commissions: 0,
    useSmartScaling: false,
    useFundedTacticalPayoutTrade: false
  };

  const result = new HistoricalReplayEngine({
    profile: replayProfile,
    riskProfile: mnqRisk,
    strategies: [{ strategy: 'a.csv', trades: [trade(0, 999), trade(1, -123)] }],
    request: {
      initialBankroll: 100,
      maxActiveAccounts: 1,
      accountCost: 0,
      horizonDays: 2,
      reinvestmentPercent: 1
    },
    sanitization: {
      mode: 'fixedOutcome',
      maxWinPoints: 10,
      maxLossPoints: 5,
      evaluation: { maxWinPoints: 10, maxLossPoints: 5 },
      funded: { maxWinPoints: 7, maxLossPoints: 3 },
      phaseSpecific: true
    }
  }).run();

  const tradeEvents = result.eventTimeline.filter(event => event.type === 'TRADE_CLOSED');
  assert.equal(tradeEvents[0].amount, 40);
  assert.equal(tradeEvents[0].accountBalance, 50040);
  assert.equal(tradeEvents[1].amount, -20);
  assert.equal(tradeEvents[1].accountBalance, 50020);
});
