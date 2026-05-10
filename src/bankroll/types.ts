import { PropFirmProfile, RandomizationConfig, RiskProfile, SimulationTrace, TraceEventType } from '../types';
import { RawTrade } from '../tradeParser';

export interface BankrollStrategyInput {
  strategy: string;
  trades: RawTrade[];
}

export interface BankrollRequest {
  profileId?: string;
  folder?: string;
  strategies?: string[];
  riskConfig?: unknown;
  initialBankroll: number;
  maxActiveAccountsPerDay: number;
  horizonMonths: number;
  iterations: number;
  reinvestmentPercent: number;
  randomization?: RandomizationConfig;
}

export interface BankrollEngineInput {
  profile: PropFirmProfile;
  riskProfile: RiskProfile;
  strategies: BankrollStrategyInput[];
  request: BankrollRequest;
}

export type BankrollEventType =
  | 'ACCOUNT_PURCHASED'
  | TraceEventType
  | 'BANKROLL_RUINED'
  | 'STALLED'
  | 'DATA_EXHAUSTED';

export interface BankrollEvent {
  day: number;
  accountId?: string;
  strategy?: string;
  type: BankrollEventType;
  message: string;
  amount?: number;
  bankrollAfter: number;
}

export interface BankrollCurvePoint {
  day: number;
  bankroll: number;
  activeAccounts: number;
  accountsPurchased: number;
  accountsBlown: number;
  payoutsTaken: number;
  withdrawnProfit: number;
}

export interface BankrollRepresentativeCurve {
  id: string;
  status: 'COMPLETED' | 'RUINED' | 'STALLED';
  finalBankroll: number;
  maxDrawdown: number;
  curve: BankrollCurvePoint[];
  events: BankrollEvent[];
}

export interface BankrollIterationResult {
  status: 'COMPLETED' | 'RUINED' | 'STALLED';
  finalBankroll: number;
  maxDrawdown: number;
  payoutsTaken: number;
  accountsPurchased: number;
  accountsBlown: number;
  withdrawnProfit: number;
  curve: BankrollCurvePoint[];
  events: BankrollEvent[];
}

export interface BankrollResponse {
  iterations: number;
  horizonDays: number;
  riskOfRuinPercent: number;
  stalledPercent: number;
  medianFinalBankroll: number;
  p10FinalBankroll: number;
  p90FinalBankroll: number;
  medianMaxDrawdown: number;
  avgPayouts: number;
  avgAccountsPurchased: number;
  avgAccountsBlown: number;
  avgWithdrawnProfit: number;
  representativeCurves: BankrollRepresentativeCurve[];
  eventSamples: BankrollEvent[];
}

export interface AccountLifecycle {
  accountId: string;
  strategy: string;
  trace: SimulationTrace;
  nextTradeIndex: number;
}
