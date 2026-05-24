import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTrade } from '../src/tradeParser';
import { prepareHistoricalDailyTrades } from '../src/historicalReplay/tradeSequence';

function trade(index: number, day: string, points = 1): RawTrade {
  return {
    ticket: String(index),
    symbol: 'MNQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime: new Date(`${day}T14:00:00Z`),
    closeTime: new Date(`${day}T14:30:00Z`),
    size: 1,
    rawPnl: points,
    netPoints: points
  };
}

test('historical replay keeps only one original trade per calendar day and normalizes to consecutive days', () => {
  const result = prepareHistoricalDailyTrades([
    trade(0, '2016-07-01', 10),
    trade(1, '2016-07-01', -10),
    trade(2, '2016-07-08', 10)
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].ticket, '0');
  assert.equal(result[1].ticket, '2');
  assert.equal(result[0].closeTime.toISOString().slice(0, 10), '2020-01-01');
  assert.equal(result[1].closeTime.toISOString().slice(0, 10), '2020-01-02');
});
