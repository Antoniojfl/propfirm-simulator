import { MonteCarloResults } from '../monteCarloEngine';

export interface DailyPnlPoint {
  date: string;
  pnl: number;
}

export interface LiveStrategyInput {
  strategy: string;
  metrics: MonteCarloResults;
  dailySeries: DailyPnlPoint[];
}

export interface CorrelationCell {
  a: string;
  b: string;
  correlation: number | null;
  overlapDays: number;
  insufficientOverlap: boolean;
}

export interface LivePortfolioRow {
  rank: number;
  strategy: string;
  baseScore: number;
  adjustedScore: number;
  avgCorrelation: number;
  metrics: MonteCarloResults;
  badges: string[];
  reasons: string[];
  warnings: string[];
}

export interface LivePortfolioRequest {
  strategies: LiveStrategyInput[];
  topN?: number;
  diversityWeight?: number;
  minOverlapDays?: number;
}

export interface LivePortfolioResponse {
  topN: number;
  diversityWeight: number;
  minOverlapDays: number;
  portfolio: LivePortfolioRow[];
  nearMisses: LivePortfolioRow[];
  correlationMatrix: CorrelationCell[];
  warnings: string[];
}
