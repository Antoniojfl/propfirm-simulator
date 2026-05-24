import { RawTrade } from '../tradeParser';

export function prepareHistoricalDailyTrades(trades: RawTrade[]): RawTrade[] {
  const seenDays = new Set<string>();
  const oneTradePerOriginalDay = [...trades]
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime())
    .filter(trade => {
      const day = trade.closeTime.toISOString().slice(0, 10);
      if (seenDays.has(day)) return false;
      seenDays.add(day);
      return true;
    });

  const start = Date.UTC(2020, 0, 1);
  return oneTradePerOriginalDay.map((trade, index) => {
    const day = new Date(start + index * 24 * 60 * 60 * 1000);
    const openTime = moveTimeToDay(trade.openTime, day);
    let closeTime = moveTimeToDay(trade.closeTime, day);
    if (closeTime.getTime() <= openTime.getTime()) {
      closeTime = new Date(openTime.getTime() + 60 * 1000);
    }
    return {
      ...trade,
      openTime,
      closeTime
    };
  });
}

function moveTimeToDay(source: Date, targetDay: Date): Date {
  return new Date(Date.UTC(
    targetDay.getUTCFullYear(),
    targetDay.getUTCMonth(),
    targetDay.getUTCDate(),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds()
  ));
}
