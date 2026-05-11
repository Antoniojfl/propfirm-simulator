import { pearsonCorrelation } from './correlation';
import { adjustedLiveScore, baseLiveScore, liveBadges, liveReasons } from './scoring';
import {
  CorrelationCell,
  LivePortfolioRequest,
  LivePortfolioResponse,
  LivePortfolioRow,
  LiveStrategyInput
} from './types';

interface CandidateState {
  input: LiveStrategyInput;
  baseScore: number;
}

interface CorrelationSummary {
  avgAbsCorrelation: number;
  warnings: string[];
}

export function buildLivePortfolio(request: LivePortfolioRequest): LivePortfolioResponse {
  const topN = Math.max(1, Math.round(Number(request.topN ?? 5)));
  const diversityWeight = Math.max(0, Math.min(1, Number(request.diversityWeight ?? 0.35)));
  const minOverlapDays = Math.max(1, Math.round(Number(request.minOverlapDays ?? 30)));
  const warnings: string[] = [];

  const candidates: CandidateState[] = request.strategies.map(input => ({
    input,
    baseScore: baseLiveScore(input.metrics)
  }));

  const selected: CandidateState[] = [];
  const portfolio: LivePortfolioRow[] = [];
  const remaining = [...candidates];

  while (portfolio.length < topN && remaining.length > 0) {
    let bestIndex = 0;
    let bestRow = toRow(remaining[0], portfolio.length + 1, selected, diversityWeight, minOverlapDays);

    for (let index = 1; index < remaining.length; index++) {
      const row = toRow(remaining[index], portfolio.length + 1, selected, diversityWeight, minOverlapDays);
      if (row.adjustedScore > bestRow.adjustedScore) {
        bestRow = row;
        bestIndex = index;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    selected.push(picked);
    portfolio.push(bestRow);
    warnings.push(...bestRow.warnings);
  }

  const nearMisses = remaining
    .map(candidate => toRow(candidate, 0, selected, diversityWeight, minOverlapDays))
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .slice(0, 10)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      badges: row.badges.filter(badge => badge !== 'Live Pick')
    }));

  return {
    topN,
    diversityWeight,
    minOverlapDays,
    portfolio,
    nearMisses,
    correlationMatrix: buildCorrelationMatrix(portfolio.map(row => row.strategy), request.strategies, minOverlapDays),
    warnings: [...new Set(warnings)]
  };
}

function toRow(
  candidate: CandidateState,
  rank: number,
  selected: CandidateState[],
  diversityWeight: number,
  minOverlapDays: number
): LivePortfolioRow {
  const correlation = summarizeCorrelation(candidate.input, selected, minOverlapDays);
  const adjustedScore = adjustedLiveScore(candidate.baseScore, correlation.avgAbsCorrelation, diversityWeight);
  const rowForBadges = { rank, avgCorrelation: correlation.avgAbsCorrelation, adjustedScore };

  return {
    rank,
    strategy: candidate.input.strategy,
    baseScore: candidate.baseScore,
    adjustedScore,
    avgCorrelation: correlation.avgAbsCorrelation,
    metrics: candidate.input.metrics,
    badges: liveBadges(candidate.input.metrics, rowForBadges),
    reasons: liveReasons(candidate.input.metrics, correlation.avgAbsCorrelation),
    warnings: correlation.warnings
  };
}

function summarizeCorrelation(candidate: LiveStrategyInput, selected: CandidateState[], minOverlapDays: number): CorrelationSummary {
  if (selected.length === 0) return { avgAbsCorrelation: 0, warnings: [] };

  const correlations: number[] = [];
  const warnings: string[] = [];

  for (const picked of selected) {
    const cell = pearsonCorrelation(candidate.dailySeries, picked.input.dailySeries, minOverlapDays);
    if (cell.insufficientOverlap || cell.correlation === null) {
      warnings.push(`${candidate.strategy} y ${picked.input.strategy}: overlap insuficiente (${cell.overlapDays} dias)`);
      continue;
    }
    correlations.push(Math.abs(cell.correlation));
  }

  return {
    avgAbsCorrelation: correlations.length
      ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
      : 0,
    warnings
  };
}

function buildCorrelationMatrix(strategyNames: string[], inputs: LiveStrategyInput[], minOverlapDays: number): CorrelationCell[] {
  const byName = new Map(inputs.map(input => [input.strategy, input]));
  const cells: CorrelationCell[] = [];

  for (let i = 0; i < strategyNames.length; i++) {
    for (let j = i + 1; j < strategyNames.length; j++) {
      const a = byName.get(strategyNames[i]);
      const b = byName.get(strategyNames[j]);
      if (!a || !b) continue;
      const cell = pearsonCorrelation(a.dailySeries, b.dailySeries, minOverlapDays);
      cells.push({
        ...cell,
        a: a.strategy,
        b: b.strategy
      });
    }
  }

  return cells;
}
