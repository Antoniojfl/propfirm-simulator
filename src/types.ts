export type AccountState = 'EVALUATION' | 'FUNDED' | 'BLOWN' | 'PASSED' | 'GRADUATED';
export type SimulationPhase = 'evaluation' | 'funded';
export type DrawdownMode = 'EOD' | 'INTRADAY' | 'STATIC';
export type RandomizationMode = 'random' | 'seeded';
export type Instrument = 'NQ' | 'MNQ' | 'ES' | 'MES';

export interface ToggleRule {
  enabled: boolean;
}

export interface ProfitTargetRule extends ToggleRule {
  amount: number;
}

export interface DrawdownRule extends ToggleRule {
  mode: DrawdownMode;
  amount: number;
  lockAtBalance?: number;
  lockOnPayout?: boolean;
}

export interface ConsistencyRule extends ToggleRule {
  maxDailyProfitPercent: number;
}

export interface MinTradingDaysRule extends ToggleRule {
  days: number;
  minProfitPerDay?: number;
  countOnlyProfitableDays?: boolean;
}

export interface ScalingTier {
  profitFrom: number;
  contracts: number;
}

export interface ScalingRule extends ToggleRule {
  updateTiming: 'EOD' | 'REALTIME';
  allowDecrease: boolean;
  tiers: ScalingTier[];
}

export interface PhaseRules {
  maxContracts: number;
  maxMiniContracts?: number;
  maxMicroContracts?: number;
  profitTarget?: ProfitTargetRule;
  drawdown: DrawdownRule;
  consistency?: ConsistencyRule;
  minTradingDays?: MinTradingDaysRule;
  scaling?: ScalingRule;
  ignoredRules?: string[];
}

export interface PayoutRules extends ToggleRule {
  minTradingDays?: number;
  minProfitPerDay?: number;
  minPayoutAmount: number;
  maxPayoutAmount?: number;
  payoutCaps?: number[];
  payoutPercent?: number;
  payoutSplit: number;
  maxPayouts?: number;
  safetyNetBalance?: number;
  reserveAmount?: number;
  consistency?: ConsistencyRule;
  positiveCycleProfitRequired?: boolean;
  deductPayout: boolean;
  resetCycleAfterPayout: boolean;
  lockDrawdownOnPayout?: boolean;
}

export interface PropFirmProfile {
  id?: string;
  firm_name: string;
  display_name?: string;
  account_size: number;
  cost: number;
  version: number;
  official: boolean;
  evalRules: PhaseRules;
  fundedRules: PhaseRules;
  payoutRules: PayoutRules;
  metadata?: {
    product?: string;
    sourceUrls?: string[];
    notes?: string[];
    ignoredRules?: string[];
  };
}

export interface PhaseRiskConfig {
  instrument: Instrument;
  contracts: number;
  pointValue: number;
}

export interface RiskProfile {
  evaluationContracts?: number;
  fundedPrePayoutContracts?: number;
  fundedPostPayoutContracts?: number;
  pointValue?: number;
  evaluation?: PhaseRiskConfig;
  fundedPrePayout?: PhaseRiskConfig;
  fundedPostPayout?: PhaseRiskConfig;
  commissions: number;
  useSmartScaling: boolean;
}

export interface RandomizationConfig {
  mode: RandomizationMode;
  seed?: string;
}

export type TraceEventType =
  | 'TRADE_CLOSED'
  | 'DRAWDOWN_UPDATED'
  | 'EVAL_PASSED'
  | 'ACCOUNT_BLOWN'
  | 'PAYOUT_ELIGIBLE'
  | 'PAYOUT_TAKEN'
  | 'CONSISTENCY_BLOCKED'
  | 'SCALING_CHANGED'
  | 'TARGET_REACHED_WAITING_DAYS'
  | 'PAYOUT_WAITING_DAYS';

export interface TraceEvent {
  type: TraceEventType;
  message: string;
  value?: number;
}

export interface TraceTrade {
  index: number;
  phase: SimulationPhase;
  ticket: string;
  symbol: string;
  instrument: Instrument;
  closeTime: string;
  netPoints: number;
  contracts: number;
  requestedContracts: number;
  executedContracts: number;
  pointValue: number;
  grossPnl: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  highWaterMark: number;
  drawdownLevel: number;
  cycleProfit: number;
  events: TraceEvent[];
}

export interface SimulationTrace {
  id: string;
  label: string;
  status: AccountState;
  summary: {
    finalBalance: number;
    totalTrades: number;
    evalTrades: number;
    fundedTrades: number;
    payoutsTaken: number;
    totalPayoutAmount: number;
    blownReason: string | null;
  };
  trades: TraceTrade[];
}

export interface AccountMetrics {
  accountId: string;
  firmName: string;
  status: AccountState;
  finalBalance: number;
  totalTrades: number;
  daysToPass: number | null;
  payoutsTaken: number;
  totalPayoutAmount: number;
  blownReason: string | null;
  fundedLifespanDays: number | null;
  maxConsecutiveLosses: number;
  profitFactor: number;
  grossWin: number;
  grossLoss: number;
  winRate: number;
  averageNetPerTrade: number;
  evalTrades: number;
  fundedTrades: number;
  evalGrossWin: number;
  evalGrossLoss: number;
  evalWinningTrades: number;
  fundedGrossWin: number;
  fundedGrossLoss: number;
  fundedWinningTrades: number;
}

export interface SimulationRunResult {
  metrics: AccountMetrics;
  trace?: SimulationTrace;
}
