import { MonteCarloEngine, MonteCarloResults } from '../monteCarloEngine';
import { PropFirmProfile, RandomizationConfig, RiskProfile } from '../types';
import { RawTrade } from '../tradeParser';
import { buildDailyPointSeries } from '../live/dailySeries';
import {
  DEFAULT_LIVE_SELECTION_CONFIG,
  LiveSelectionConfig,
  LiveSelectionEvaluation,
  LiveSelectionResponse,
  PeriodMetrics
} from './types';
import { filterTradesByRange } from './periodSplitter';
import { buildYearlyMatrix } from './yearlyMatrix';
import { evaluateStrategy, yearlyVerdictCounts } from './strategyEvaluator';
import { buildLiveSelectionPortfolio } from './portfolioBuilder';

export interface LiveSelectionStrategyInput {
  strategy: string;
  trades: RawTrade[];
}

export interface LiveSelectionEngineInput {
  profile: PropFirmProfile;
  riskProfile: RiskProfile;
  strategies: LiveSelectionStrategyInput[];
  randomization?: RandomizationConfig;
  config?: Partial<LiveSelectionConfig>;
}

export class LiveSelectionEngine {
  private profile: PropFirmProfile;
  private riskProfile: RiskProfile;
  private strategies: LiveSelectionStrategyInput[];
  private randomization: RandomizationConfig;
  private config: LiveSelectionConfig;

  constructor(input: LiveSelectionEngineInput) {
    this.profile = input.profile;
    this.riskProfile = input.riskProfile;
    this.strategies = input.strategies;
    this.randomization = input.randomization ?? { mode: 'seeded', seed: 'live-selection-v1' };
    this.config = normalizeLiveSelectionConfig(input.config);
  }

  run(): LiveSelectionResponse {
    const evaluated = this.strategies.map(strategy => this.evaluate(strategy));
    return this.buildResponse(evaluated);
  }

  async runProgressive(options?: {
    onProgress?: (current: number, total: number, strategy: string) => void;
    yieldToEventLoop?: () => Promise<void>;
  }): Promise<LiveSelectionResponse> {
    const evaluated: LiveSelectionEvaluation[] = [];
    for (const [index, strategy] of this.strategies.entries()) {
      options?.onProgress?.(index, this.strategies.length, strategy.strategy);
      evaluated.push(this.evaluate(strategy));
      await options?.yieldToEventLoop?.();
    }
    options?.onProgress?.(this.strategies.length, this.strategies.length, 'Completado');
    return this.buildResponse(evaluated);
  }

  private buildResponse(evaluated: LiveSelectionEvaluation[]): LiveSelectionResponse {
    const candidates = evaluated
      .filter(row => row.status === 'LIVE_CANDIDATE')
      .sort((a, b) => b.liveScore - a.liveScore);
    const watchlist = evaluated
      .filter(row => row.status === 'WATCHLIST')
      .sort((a, b) => b.liveScore - a.liveScore);
    const rejected = evaluated
      .filter(row => row.status === 'REJECT')
      .sort((a, b) => b.liveScore - a.liveScore);
    const portfolioResult = buildLiveSelectionPortfolio({
      candidates,
      portfolioSize: this.config.portfolioSize,
      diversityWeight: this.config.diversityWeight,
      minOverlapDays: this.config.minTradesPerYear
    });

    return {
      config: this.config,
      summary: {
        analyzed: evaluated.length,
        liveCandidates: candidates.length,
        watchlist: watchlist.length,
        rejected: rejected.length,
        portfolioMedianEvPerDay: median(portfolioResult.portfolio.map(row => row.evPerDay))
      },
      portfolio: portfolioResult.portfolio,
      candidates,
      watchlist,
      rejected,
      nearMisses: portfolioResult.nearMisses,
      correlationMatrix: portfolioResult.correlationMatrix,
      warnings: [...new Set([...portfolioResult.warnings, ...evaluated.flatMap(row => row.warnings)])]
    };
  }

  private evaluate(input: LiveSelectionStrategyInput): LiveSelectionEvaluation {
    const oosTrades = filterTradesByRange(input.trades, this.config.oosRange);
    const recentTrades = filterTradesByRange(input.trades, this.config.recentRange);
    const yearlyMatrix = buildYearlyMatrix(oosTrades, this.config.oosRange, this.config.minTradesPerYear);
    const oos = this.runPeriod(input.strategy, oosTrades, 'oos');
    const recent = this.runPeriod(input.strategy, recentTrades, 'recent');
    const full = this.runPeriod(input.strategy, input.trades, 'full');
    const decision = evaluateStrategy({
      totalTrades: input.trades.length,
      oosTrades: oosTrades.length,
      yearlyMatrix,
      oosMetrics: oos.monteCarlo,
      config: this.config
    });
    const counts = yearlyVerdictCounts(yearlyMatrix);

    return {
      strategy: input.strategy,
      status: decision.status,
      liveScore: decision.liveScore,
      adjustedScore: decision.liveScore,
      evPerDay: decision.evPerDay,
      avgCorrelation: 0,
      totalTrades: input.trades.length,
      oosTrades: oosTrades.length,
      oosPassYears: counts.pass,
      oosWeakYears: counts.weak,
      oosFailYears: counts.fail,
      oosLowSampleYears: counts.lowSample,
      yearlyMatrix,
      oos,
      recent,
      full,
      dailySeries: buildDailyPointSeries(input.trades),
      reasons: decision.reasons,
      warnings: decision.warnings
    };
  }

  private runPeriod(strategy: string, trades: RawTrade[], label: string): PeriodMetrics {
    if (trades.length === 0) return { trades: 0, monteCarlo: null };
    const metrics = new MonteCarloEngine(
      this.profile,
      this.riskProfile,
      trades,
      this.config.iterations,
      {
        mode: 'seeded',
        seed: `${this.randomization.seed ?? 'live-selection-v1'}:${strategy}:${label}`
      }
    ).run();
    return { trades: trades.length, monteCarlo: metrics };
  }
}

export function normalizeLiveSelectionConfig(config?: Partial<LiveSelectionConfig>): LiveSelectionConfig {
  return {
    ...DEFAULT_LIVE_SELECTION_CONFIG,
    ...config,
    oosRange: {
      ...DEFAULT_LIVE_SELECTION_CONFIG.oosRange,
      ...config?.oosRange
    },
    recentRange: {
      ...DEFAULT_LIVE_SELECTION_CONFIG.recentRange,
      ...config?.recentRange
    },
    portfolioSize: positiveInteger(config?.portfolioSize, DEFAULT_LIVE_SELECTION_CONFIG.portfolioSize),
    diversityWeight: Math.max(0, Math.min(1, Number(config?.diversityWeight ?? DEFAULT_LIVE_SELECTION_CONFIG.diversityWeight))),
    minTotalTrades: positiveInteger(config?.minTotalTrades, DEFAULT_LIVE_SELECTION_CONFIG.minTotalTrades),
    minOosTrades: positiveInteger(config?.minOosTrades, DEFAULT_LIVE_SELECTION_CONFIG.minOosTrades),
    minTradesPerYear: positiveInteger(config?.minTradesPerYear, DEFAULT_LIVE_SELECTION_CONFIG.minTradesPerYear),
    minOosPassingYears: positiveInteger(config?.minOosPassingYears, DEFAULT_LIVE_SELECTION_CONFIG.minOosPassingYears),
    maxOosFailYears: Math.max(0, Math.round(Number(config?.maxOosFailYears ?? DEFAULT_LIVE_SELECTION_CONFIG.maxOosFailYears))),
    iterations: positiveInteger(config?.iterations, DEFAULT_LIVE_SELECTION_CONFIG.iterations)
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.round(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
