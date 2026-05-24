import { createSeededRng } from '../random';
import { SimulationEngine } from '../simulationEngine';
import { NormalizedTradeSanitizationConfig } from '../tradeSanitizer';
import { PropFirmProfile, RiskProfile } from '../types';
import { RawTrade } from '../tradeParser';
import { HistoricalReplayAccount } from './types';

export function createHistoricalReplayAccount(input: {
  accountId: string;
  strategy: string;
  profile: PropFirmProfile;
  riskProfile: RiskProfile;
  trades: RawTrade[];
  fundedTrades?: RawTrade[];
  sanitization?: NormalizedTradeSanitizationConfig;
}): HistoricalReplayAccount {
  const engine = new SimulationEngine(
    input.profile,
    input.riskProfile,
    input.trades,
    averageTradesPerDay(input.trades),
    true,
    createSeededRng(`historical-replay:${input.accountId}`),
    input.sanitization,
    input.fundedTrades
  );
  const { trace } = engine.run();
  const fallbackTrace = {
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
  const accountTrace = trace ?? fallbackTrace;
  accountTrace.id = input.accountId;
  accountTrace.label = `${input.accountId} ${input.strategy}`;

  return {
    accountId: input.accountId,
    strategy: input.strategy,
    trace: accountTrace,
    nextTradeIndex: 0
  };
}

function averageTradesPerDay(trades: RawTrade[]): number {
  if (trades.length <= 1) return 1;
  const firstDate = trades[0].openTime.getTime();
  const lastDate = trades[trades.length - 1].closeTime.getTime();
  const totalDays = (lastDate - firstDate) / (1000 * 3600 * 24);
  return trades.length / Math.max(totalDays, 1);
}
