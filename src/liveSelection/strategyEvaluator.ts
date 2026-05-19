import { MonteCarloResults } from '../monteCarloEngine';
import { YearlyMatrixRow, LiveSelectionConfig, LiveSelectionStatus } from './types';
import { calculateLiveScore, evPerCycleDay } from './liveScore';

export interface StrategyEvaluationDecision {
  status: LiveSelectionStatus;
  liveScore: number;
  evPerDay: number;
  reasons: string[];
  warnings: string[];
}

export function evaluateStrategy(input: {
  totalTrades: number;
  oosTrades: number;
  yearlyMatrix: YearlyMatrixRow[];
  oosMetrics: MonteCarloResults | null;
  config: LiveSelectionConfig;
}): StrategyEvaluationDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const liveScore = calculateLiveScore(input.oosMetrics, input.yearlyMatrix);
  const evPerDay = evPerCycleDay(input.oosMetrics);
  const counts = yearlyVerdictCounts(input.yearlyMatrix);

  if (input.totalTrades < input.config.minTotalTrades) {
    reasons.push(`Muestra total insuficiente (${input.totalTrades}/${input.config.minTotalTrades})`);
    return { status: 'REJECT', liveScore, evPerDay, reasons, warnings };
  }

  if (input.oosTrades < input.config.minOosTrades) {
    reasons.push(`Muestra OOS insuficiente (${input.oosTrades}/${input.config.minOosTrades})`);
    return { status: 'REJECT', liveScore, evPerDay, reasons, warnings };
  }

  if (counts.fail > input.config.maxOosFailYears) {
    reasons.push(`Demasiados años FAIL OOS (${counts.fail})`);
    return { status: 'REJECT', liveScore, evPerDay, reasons, warnings };
  }

  if (counts.pass + counts.weak < input.config.minOosPassingYears) {
    reasons.push(`No cumple mayoría positiva OOS (${counts.pass + counts.weak}/${input.config.minOosPassingYears})`);
    return { status: 'REJECT', liveScore, evPerDay, reasons, warnings };
  }

  if (!input.oosMetrics || input.oosMetrics.expectedValue <= 0 || evPerDay <= 0) {
    reasons.push('EV por tiempo OOS no positivo');
    return { status: 'REJECT', liveScore, evPerDay, reasons, warnings };
  }

  if (input.oosMetrics.fundedBlowUpRate >= 70) {
    reasons.push(`Funded blow-up OOS alto (${input.oosMetrics.fundedBlowUpRate.toFixed(1)}%)`);
    return { status: 'WATCHLIST', liveScore, evPerDay, reasons, warnings };
  }

  if (counts.lowSample > 3) {
    reasons.push(`Demasiados años LOW_SAMPLE (${counts.lowSample})`);
    return { status: 'WATCHLIST', liveScore, evPerDay, reasons, warnings };
  }

  reasons.push(`EV/day OOS ${money(evPerDay)}`);
  reasons.push(`Años positivos ${counts.pass + counts.weak}/${input.yearlyMatrix.length}`);
  reasons.push(`Payout OOS ${input.oosMetrics.payoutRatePercent.toFixed(1)}%`);
  return { status: 'LIVE_CANDIDATE', liveScore, evPerDay, reasons, warnings };
}

export function yearlyVerdictCounts(yearlyMatrix: YearlyMatrixRow[]) {
  return {
    pass: yearlyMatrix.filter(row => row.verdict === 'PASS').length,
    weak: yearlyMatrix.filter(row => row.verdict === 'WEAK').length,
    fail: yearlyMatrix.filter(row => row.verdict === 'FAIL').length,
    lowSample: yearlyMatrix.filter(row => row.verdict === 'LOW_SAMPLE').length
  };
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}
