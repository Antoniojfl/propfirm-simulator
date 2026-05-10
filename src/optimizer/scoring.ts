import { MonteCarloResults } from '../monteCarloEngine';

export function scoreRiskAdjustedEV(metrics: MonteCarloResults): number {
  const pass = metrics.passRatePercent / 100;
  const payout = metrics.payoutRatePercent / 100;
  const fundedSurvival = Math.max(0, 1 - (metrics.fundedBlowUpRate / 100));
  const lossPenalty = 1 / (1 + Math.max(0, metrics.medianMaxConsecutiveLosses - 4) * 0.08);
  const timePenalty = 1 / (1 + Math.max(0, metrics.avgDaysToPass - 20) * 0.02);
  return metrics.expectedValue * pass * payout * fundedSurvival * lossPenalty * timePenalty;
}

export function badgesFor(metrics: MonteCarloResults, score: number, bestScore: number, fastestDays: number, bestStability: number): string[] {
  const badges: string[] = [];
  if (score === bestScore) badges.push('Best Risk-Adjusted');
  if (metrics.avgDaysToPass === fastestDays && metrics.passRatePercent > 0) badges.push('Fastest Payout');
  if (metrics.medianMaxConsecutiveLosses === bestStability) badges.push('Most Stable');
  return badges;
}
