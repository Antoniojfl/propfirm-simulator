import { PropFirmProfile, RandomizationConfig, RiskProfile, SimulationTrace, TraceEventType, TradeSanitizationConfig } from '../types';
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
  operatingReserveTarget?: number;
  randomization?: RandomizationConfig;
  sanitization?: TradeSanitizationConfig;
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
  withdrawnProfitAfter?: number;
  totalNetWorthAfter?: number;
}

export interface BankrollCurvePoint {
  day: number;
  bankroll: number;
  deployableBankroll: number;
  surplusProfit: number;
  reserveCoveragePercent: number;
  withdrawnProfit: number;
  totalNetWorth: number;
  netProfit: number;
  activeAccounts: number;
  accountsPurchased: number;
  accountsBlown: number;
  payoutsTaken: number;
}

export interface BankrollRepresentativeCurve {
  id: string;
  status: 'COMPLETED' | 'RUINED' | 'STALLED';
  finalBankroll: number;
  finalDeployableBankroll: number;
  finalSurplusProfit: number;
  finalReserveCoveragePercent: number;
  finalWithdrawnProfit: number;
  finalTotalNetWorth: number;
  finalNetProfit: number;
  maxDrawdown: number;
  curve: BankrollCurvePoint[];
  events: BankrollEvent[];
}

export interface BankrollIterationResult {
  status: 'COMPLETED' | 'RUINED' | 'STALLED';
  finalBankroll: number;
  finalDeployableBankroll: number;
  finalSurplusProfit: number;
  finalReserveCoveragePercent: number;
  finalWithdrawnProfit: number;
  finalTotalNetWorth: number;
  finalNetProfit: number;
  roiPercent: number;
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
  medianOperatingBankroll: number;
  operatingReserveTarget: number;
  medianDeployableBankroll: number;
  medianSurplusProfit: number;
  p10SurplusProfit: number;
  p90SurplusProfit: number;
  medianReserveCoveragePercent: number;
  p10OperatingBankroll: number;
  p90OperatingBankroll: number;
  medianWithdrawnProfit: number;
  medianTotalNetWorth: number;
  medianNetProfit: number;
  medianROIPercent: number;
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
