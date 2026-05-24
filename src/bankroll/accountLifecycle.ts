import { MonteCarloEngine } from '../monteCarloEngine';
import { PropFirmProfile, RandomizationConfig, RiskProfile } from '../types';
import { RawTrade } from '../tradeParser';
import { AccountLifecycle } from './types';
import { NormalizedTradeSanitizationConfig } from '../tradeSanitizer';

export function createAccountLifecycle(input: {
  accountId: string;
  strategy: string;
  profile: PropFirmProfile;
  riskProfile: RiskProfile;
  trades: RawTrade[];
  fundedTrades?: RawTrade[];
  randomization: RandomizationConfig;
  sanitization?: NormalizedTradeSanitizationConfig;
}): AccountLifecycle {
  const engine = new MonteCarloEngine(input.profile, input.riskProfile, input.trades, 1, input.randomization, input.sanitization, input.fundedTrades);
  const trace = engine.buildTraces(1)[0] ?? {
    id: input.accountId,
    label: input.accountId,
    status: 'BLOWN' as const,
    summary: {
      finalBalance: input.profile.account_size,
      totalTrades: 0,
      evalTrades: 0,
      fundedTrades: 0,
      payoutsTaken: 0,
      totalPayoutAmount: 0,
      blownReason: 'No trades available'
    },
    trades: []
  };
  trace.id = input.accountId;
  trace.label = `${input.accountId} ${input.strategy}`;
  return {
    accountId: input.accountId,
    strategy: input.strategy,
    trace,
    nextTradeIndex: 0
  };
}
