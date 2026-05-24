import { NormalizedTradeSanitizationConfig } from '../tradeSanitizer';
import { PropFirmProfile, RiskProfile, SimulationTrace, TraceEventType, TradeSanitizationConfig } from '../types';
import { RawTrade } from '../tradeParser';

export interface HistoricalReplayStrategyInput {
  strategy: string;
  fundedStrategy?: string;
  trades: RawTrade[];
  fundedTrades?: RawTrade[];
}

export interface HistoricalReplayRequest {
  profileId?: string;
  folder?: string;
  fundedFolder?: string;
  strategies?: string[];
  riskConfig?: unknown;
  sanitization?: TradeSanitizationConfig;
  initialBankroll: number;
  maxActiveAccounts: number;
  accountCost?: number;
  horizonDays?: number;
  reinvestmentPercent: number;
}

export interface HistoricalReplayEngineInput {
  profile: PropFirmProfile;
  riskProfile: RiskProfile;
  strategies: HistoricalReplayStrategyInput[];
  request: HistoricalReplayRequest;
  sanitization?: NormalizedTradeSanitizationConfig;
}

export type HistoricalReplayEventType =
  | 'ACCOUNT_PURCHASED'
  | TraceEventType
  | 'DATA_EXHAUSTED'
  | 'BANKROLL_DEPLETED';

export interface HistoricalReplayEvent {
  day: number;
  date?: string;
  accountId?: string;
  strategy?: string;
  type: HistoricalReplayEventType;
  message: string;
  amount?: number;
  accountBalance?: number;
  accountDrawdownLevel?: number;
  accountHighWaterMark?: number;
  tradePnL?: number;
  cashAfter: number;
  withdrawnProfitAfter: number;
  totalNetWorthAfter: number;
}

export interface HistoricalReplayCurvePoint {
  day: number;
  cashBalance: number;
  withdrawnProfit: number;
  totalNetWorth: number;
  netProfit: number;
  activeAccounts: number;
  accountsPurchased: number;
  accountsBlown: number;
  payoutsTaken: number;
}

export interface HistoricalReplayResponse {
  horizonDays: number;
  accountsPurchased: number;
  accountsBlown: number;
  accountCostTotal: number;
  payoutsTaken: number;
  grossPayouts: number;
  withdrawnProfit: number;
  cashBalance: number;
  netProfit: number;
  roiPercent: number;
  activeAccounts: number;
  dataExhausted: number;
  maxDrawdown: number;
  eventTimeline: HistoricalReplayEvent[];
  dailyCurve: HistoricalReplayCurvePoint[];
}

export interface HistoricalReplayAccount {
  accountId: string;
  strategy: string;
  trace: SimulationTrace;
  nextTradeIndex: number;
}
