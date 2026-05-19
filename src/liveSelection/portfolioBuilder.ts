import { pearsonCorrelation } from '../live/correlation';
import { CorrelationCell } from '../live/types';
import { LiveSelectionEvaluation, LiveSelectionPortfolioRow } from './types';

export function buildLiveSelectionPortfolio(input: {
  candidates: LiveSelectionEvaluation[];
  portfolioSize: number;
  diversityWeight: number;
  minOverlapDays?: number;
}): {
  portfolio: LiveSelectionPortfolioRow[];
  nearMisses: LiveSelectionEvaluation[];
  correlationMatrix: CorrelationCell[];
  warnings: string[];
} {
  const selected: LiveSelectionEvaluation[] = [];
  const portfolio: LiveSelectionPortfolioRow[] = [];
  const remaining = [...input.candidates].sort((a, b) => b.liveScore - a.liveScore);
  const warnings: string[] = [];
  const minOverlapDays = input.minOverlapDays ?? 30;

  while (portfolio.length < input.portfolioSize && remaining.length > 0) {
    let bestIndex = 0;
    let bestCandidate = withCorrelation(remaining[0], selected, input.diversityWeight, minOverlapDays);

    for (let index = 1; index < remaining.length; index++) {
      const candidate = withCorrelation(remaining[index], selected, input.diversityWeight, minOverlapDays);
      if (candidate.adjustedScore > bestCandidate.adjustedScore) {
        bestCandidate = candidate;
        bestIndex = index;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    const pickedWithCorrelation = withCorrelation(picked, selected, input.diversityWeight, minOverlapDays);
    selected.push(pickedWithCorrelation);
    portfolio.push({ ...pickedWithCorrelation, rank: portfolio.length + 1 });
    warnings.push(...pickedWithCorrelation.warnings);
  }

  const nearMisses = remaining
    .map(candidate => withCorrelation(candidate, selected, input.diversityWeight, minOverlapDays))
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .slice(0, 10);

  return {
    portfolio,
    nearMisses,
    correlationMatrix: buildCorrelationMatrix(portfolio, minOverlapDays),
    warnings: [...new Set(warnings)]
  };
}

function withCorrelation(
  candidate: LiveSelectionEvaluation,
  selected: LiveSelectionEvaluation[],
  diversityWeight: number,
  minOverlapDays: number
): LiveSelectionEvaluation {
  if (selected.length === 0) {
    return { ...candidate, avgCorrelation: 0, adjustedScore: candidate.liveScore };
  }

  const correlations: number[] = [];
  const warnings = [...candidate.warnings];
  for (const picked of selected) {
    const cell = pearsonCorrelation(candidate.dailySeries, picked.dailySeries, minOverlapDays);
    if (cell.insufficientOverlap || cell.correlation === null) {
      warnings.push(`${candidate.strategy} y ${picked.strategy}: overlap insuficiente (${cell.overlapDays} dias)`);
      continue;
    }
    correlations.push(Math.abs(cell.correlation));
  }

  const avgCorrelation = correlations.length
    ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
    : 0;
  const adjustedScore = candidate.liveScore - Math.abs(candidate.liveScore) * avgCorrelation * Math.max(0, diversityWeight);
  return { ...candidate, avgCorrelation, adjustedScore, warnings };
}

function buildCorrelationMatrix(portfolio: LiveSelectionPortfolioRow[], minOverlapDays: number): CorrelationCell[] {
  const cells: CorrelationCell[] = [];
  for (let i = 0; i < portfolio.length; i++) {
    for (let j = i + 1; j < portfolio.length; j++) {
      const cell = pearsonCorrelation(portfolio[i].dailySeries, portfolio[j].dailySeries, minOverlapDays);
      cells.push({
        ...cell,
        a: portfolio[i].strategy,
        b: portfolio[j].strategy
      });
    }
  }
  return cells;
}
