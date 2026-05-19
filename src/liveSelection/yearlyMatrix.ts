import { RawTrade } from '../tradeParser';
import { YearRange, YearlyMatrixRow, YearlyVerdict } from './types';
import { splitTradesByYear } from './periodSplitter';

export function buildYearlyMatrix(trades: RawTrade[], range: YearRange, minTradesPerYear: number): YearlyMatrixRow[] {
  const byYear = splitTradesByYear(trades);
  const rows: YearlyMatrixRow[] = [];

  for (let year = range.start; year <= range.end; year++) {
    const yearTrades = byYear.get(year) ?? [];
    const stats = calculateYearStats(yearTrades);
    rows.push({
      year,
      ...stats,
      verdict: verdictForYear(stats, minTradesPerYear)
    });
  }

  return rows;
}

export function calculateYearStats(trades: RawTrade[]): Omit<YearlyMatrixRow, 'year' | 'verdict'> {
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let currentLosses = 0;
  let maxConsecutiveLosses = 0;

  for (const trade of trades) {
    const points = Number(trade.netPoints || 0);
    if (points > 0) {
      grossWin += points;
      wins++;
      currentLosses = 0;
    } else if (points < 0) {
      grossLoss += Math.abs(points);
      currentLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    }
  }

  const netPoints = trades.reduce((sum, trade) => sum + Number(trade.netPoints || 0), 0);
  const tradesCount = trades.length;
  return {
    trades: tradesCount,
    netPoints,
    winRatePercent: tradesCount > 0 ? (wins / tradesCount) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    maxConsecutiveLosses,
    expectancyPoints: tradesCount > 0 ? netPoints / tradesCount : 0
  };
}

export function verdictForYear(
  stats: Omit<YearlyMatrixRow, 'year' | 'verdict'>,
  minTradesPerYear: number
): YearlyVerdict {
  if (stats.trades < minTradesPerYear) return 'LOW_SAMPLE';
  if (stats.netPoints > 0 && stats.profitFactor >= 1.05) return 'PASS';
  if (stats.netPoints > 0 || stats.profitFactor >= 0.95) return 'WEAK';
  return 'FAIL';
}
