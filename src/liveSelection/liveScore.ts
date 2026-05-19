import { MonteCarloResults } from '../monteCarloEngine';
import { YearlyMatrixRow } from './types';

export function evPerCycleDay(metrics: MonteCarloResults | null): number {
  if (!metrics) return 0;
  const cycleDays = Math.max(1, metrics.avgDaysToPass + metrics.medianFundedLifespanDays);
  return metrics.expectedValue / cycleDays;
}

export function calculateLiveScore(
  metrics: MonteCarloResults | null,
  yearlyMatrix: YearlyMatrixRow[]
): number {
  if (!metrics) return 0;

  const pass = metrics.passRatePercent / 100;
  const payout = metrics.payoutRatePercent / 100;
  const fundedSurvival = Math.max(0, 1 - metrics.fundedBlowUpRate / 100);
  const lossPenalty = 1 / (1 + Math.max(0, metrics.medianMaxConsecutiveLosses - 4) * 0.08);
  const payoutDepthBonus = 1 + Math.max(0, metrics.percentAccounts3PlusPayouts || 0) / 100 * 0.2;
  const stabilityMultiplier = annualStabilityMultiplier(yearlyMatrix);

  return evPerCycleDay(metrics) * pass * payout * fundedSurvival * lossPenalty * payoutDepthBonus * stabilityMultiplier;
}

export function annualStabilityMultiplier(yearlyMatrix: YearlyMatrixRow[]): number {
  if (yearlyMatrix.length === 0) return 0;
  const pass = yearlyMatrix.filter(row => row.verdict === 'PASS').length;
  const weak = yearlyMatrix.filter(row => row.verdict === 'WEAK').length;
  const fail = yearlyMatrix.filter(row => row.verdict === 'FAIL').length;
  const usableYears = yearlyMatrix.length - yearlyMatrix.filter(row => row.verdict === 'LOW_SAMPLE').length;
  if (usableYears <= 0) return 0.25;
  const positiveRatio = (pass + weak * 0.5) / usableYears;
  const failPenalty = Math.max(0.35, 1 - fail * 0.14);
  return Math.max(0.25, positiveRatio * failPenalty);
}
