import { scoreRiskAdjustedEV } from '../optimizer/scoring';
import { MonteCarloResults } from '../monteCarloEngine';

export function baseLiveScore(metrics: MonteCarloResults): number {
  const payoutDepthBonus = 1 + Math.max(0, metrics.percentAccounts3PlusPayouts || 0) / 100 * 0.25;
  return scoreRiskAdjustedEV(metrics) * payoutDepthBonus;
}

export function adjustedLiveScore(baseScore: number, avgAbsCorrelation: number, diversityWeight: number): number {
  return baseScore - Math.abs(baseScore) * Math.max(0, avgAbsCorrelation) * Math.max(0, diversityWeight);
}

export function liveBadges(metrics: MonteCarloResults, row: { rank: number; avgCorrelation: number; adjustedScore: number }): string[] {
  const badges: string[] = [];
  if (row.rank > 0 && row.rank <= 5) badges.push('Live Pick');
  if (metrics.expectedValue > 0 && metrics.payoutRatePercent >= 25) badges.push('High EV');
  if (metrics.fundedBlowUpRate >= 60) badges.push('High Blow-up');
  if (metrics.medianMaxConsecutiveLosses <= 4 && metrics.fundedBlowUpRate < 40) badges.push('Stable');
  if (row.avgCorrelation >= 0.65) badges.push('Correlated');
  return badges;
}

export function liveReasons(metrics: MonteCarloResults, avgCorrelation: number): string[] {
  const reasons: string[] = [];
  reasons.push(`EV ${money(metrics.expectedValue)}`);
  reasons.push(`Pass ${metrics.passRatePercent.toFixed(1)}%`);
  reasons.push(`Payout ${metrics.payoutRatePercent.toFixed(1)}%`);
  reasons.push(`Blow-up funded ${metrics.fundedBlowUpRate.toFixed(1)}%`);
  if (avgCorrelation > 0) reasons.push(`Corr ${avgCorrelation.toFixed(2)}`);
  return reasons;
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}
