import { RawTrade } from '../tradeParser';
import { DailyPnlPoint } from './types';

export function buildDailyPointSeries(trades: RawTrade[]): DailyPnlPoint[] {
  const byDate = new Map<string, number>();

  for (const trade of trades) {
    const date = trade.closeTime.toISOString().slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + Number(trade.netPoints || 0));
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => ({ date, pnl }));
}
