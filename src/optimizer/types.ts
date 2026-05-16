import { Instrument, PropFirmProfile, RandomizationConfig, RiskProfile, TradeSanitizationConfig } from '../types';
import { RawTrade } from '../tradeParser';
import { MonteCarloResults } from '../monteCarloEngine';

export interface OptimizerRange {
  min: number;
  max: number;
}

export interface OptimizerPhaseSearch {
  instruments: Instrument[];
  contracts: OptimizerRange;
}

export interface OptimizerRequest {
  profileId?: string;
  folder?: string;
  strategy?: string;
  iterations?: number;
  randomization?: RandomizationConfig;
  sanitization?: TradeSanitizationConfig;
  commissions?: number;
  useSmartScaling?: boolean | 'both';
  useFundedTacticalPayoutTrade?: boolean;
  tacticalPayoutWinRate?: number;
  tacticalPayoutRiskReward?: number;
  evaluation?: OptimizerPhaseSearch;
  fundedPrePayout?: OptimizerPhaseSearch;
  fundedPostPayout?: OptimizerPhaseSearch;
  maxCandidates?: number;
}

export interface OptimizerStrategyInput {
  strategy: string;
  trades: RawTrade[];
}

export interface OptimizerEngineInput {
  profile: PropFirmProfile;
  strategies: OptimizerStrategyInput[];
  request: OptimizerRequest;
}

export interface OptimizerCandidate {
  id: string;
  label: string;
  riskProfile: RiskProfile;
}

export interface OptimizerResultRow {
  strategy: string;
  candidate: OptimizerCandidate;
  metrics: MonteCarloResults;
  score: number;
  badges: string[];
}

export interface OptimizerResponse {
  iterations: number;
  objective: 'riskAdjustedEV';
  results: OptimizerResultRow[];
  candidateCount: number;
}
