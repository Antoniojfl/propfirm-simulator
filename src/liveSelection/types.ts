import { MonteCarloResults } from '../monteCarloEngine';
import { RandomizationConfig, RiskProfile, TradeSanitizationConfig } from '../types';
import { DailyPnlPoint, CorrelationCell } from '../live/types';

export type LiveSelectionStatus = 'LIVE_CANDIDATE' | 'WATCHLIST' | 'REJECT';
export type YearlyVerdict = 'PASS' | 'WEAK' | 'FAIL' | 'LOW_SAMPLE';

export interface YearRange {
  start: number;
  end: number;
}

export interface LiveSelectionConfig {
  oosRange: YearRange;
  recentRange: YearRange;
  portfolioSize: number;
  diversityWeight: number;
  minTotalTrades: number;
  minOosTrades: number;
  minTradesPerYear: number;
  minOosPassingYears: number;
  maxOosFailYears: number;
  iterations: number;
}

export interface LiveSelectionRequest {
  profileId?: string;
  folder?: string;
  riskConfig?: unknown;
  sanitization?: TradeSanitizationConfig;
  randomization?: RandomizationConfig;
  config?: Partial<LiveSelectionConfig>;
}

export interface YearlyMatrixRow {
  year: number;
  trades: number;
  netPoints: number;
  winRatePercent: number;
  profitFactor: number;
  maxConsecutiveLosses: number;
  expectancyPoints: number;
  verdict: YearlyVerdict;
}

export interface PeriodMetrics {
  trades: number;
  monteCarlo: MonteCarloResults | null;
}

export interface LiveSelectionEvaluation {
  strategy: string;
  status: LiveSelectionStatus;
  liveScore: number;
  adjustedScore: number;
  evPerDay: number;
  avgCorrelation: number;
  totalTrades: number;
  oosTrades: number;
  oosPassYears: number;
  oosWeakYears: number;
  oosFailYears: number;
  oosLowSampleYears: number;
  yearlyMatrix: YearlyMatrixRow[];
  oos: PeriodMetrics;
  recent: PeriodMetrics;
  full: PeriodMetrics;
  dailySeries: DailyPnlPoint[];
  reasons: string[];
  warnings: string[];
}

export interface LiveSelectionPortfolioRow extends LiveSelectionEvaluation {
  rank: number;
}

export interface LiveSelectionResponse {
  config: LiveSelectionConfig;
  summary: {
    analyzed: number;
    liveCandidates: number;
    watchlist: number;
    rejected: number;
    portfolioMedianEvPerDay: number;
  };
  portfolio: LiveSelectionPortfolioRow[];
  candidates: LiveSelectionEvaluation[];
  watchlist: LiveSelectionEvaluation[];
  rejected: LiveSelectionEvaluation[];
  nearMisses: LiveSelectionEvaluation[];
  correlationMatrix: CorrelationCell[];
  warnings: string[];
}

export const DEFAULT_LIVE_SELECTION_CONFIG: LiveSelectionConfig = {
  oosRange: { start: 2015, end: 2022 },
  recentRange: { start: 2023, end: 2026 },
  portfolioSize: 5,
  diversityWeight: 0.35,
  minTotalTrades: 500,
  minOosTrades: 250,
  minTradesPerYear: 30,
  minOosPassingYears: 5,
  maxOosFailYears: 2,
  iterations: 1000
};

export const DEFAULT_LIVE_SELECTION_FOLDER = 'stop 825 2015 cierre 2245';
