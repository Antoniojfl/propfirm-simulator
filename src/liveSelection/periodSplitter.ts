import { RawTrade } from '../tradeParser';
import { YearRange } from './types';

export function tradeYear(trade: RawTrade): number {
  return trade.closeTime.getUTCFullYear();
}

export function isTradeInRange(trade: RawTrade, range: YearRange): boolean {
  const year = tradeYear(trade);
  return year >= range.start && year <= range.end;
}

export function filterTradesByRange(trades: RawTrade[], range: YearRange): RawTrade[] {
  return trades.filter(trade => isTradeInRange(trade, range));
}

export function splitTradesByYear(trades: RawTrade[]): Map<number, RawTrade[]> {
  const byYear = new Map<number, RawTrade[]>();
  for (const trade of trades) {
    const year = tradeYear(trade);
    const bucket = byYear.get(year) ?? [];
    bucket.push(trade);
    byYear.set(year, bucket);
  }
  return byYear;
}
