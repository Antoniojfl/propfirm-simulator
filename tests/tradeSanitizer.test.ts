import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTrades } from '../src/tradeSanitizer';
import { RawTrade } from '../src/tradeParser';

function trade(index: number, points: number): RawTrade {
  return {
    ticket: String(index),
    symbol: 'NQ',
    type: 'Buy',
    openPrice: 100,
    closePrice: 100 + points,
    openTime: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T14:00:00Z`),
    closeTime: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T14:15:00Z`),
    size: 1,
    rawPnl: points * 20,
    netPoints: points
  };
}

test('fixed outcome sanitizer snaps every winner and loser to fixed TP SL points', () => {
  const input = [82.5, 43.4, 6.5, -17, -82.5, 130, -140, 0].map((points, index) => trade(index, points));
  const result = sanitizeTrades(input, {
    mode: 'fixedOutcome',
    maxWinPoints: 82.5,
    maxLossPoints: 82.5
  });

  assert.deepEqual(result.trades.map(item => item.netPoints), [82.5, 82.5, 82.5, -82.5, -82.5, 82.5, -82.5, 0]);
  assert.equal(result.report.adjustedTrades, 5);
  assert.equal(result.report.positiveAdjustedTrades, 3);
  assert.equal(result.report.negativeAdjustedTrades, 2);
});

test('raw trade sanitizer leaves trades untouched', () => {
  const input = [trade(0, -100), trade(1, 100)];
  const result = sanitizeTrades(input, { mode: 'raw' });

  assert.equal(result.trades, input);
  assert.equal(result.report.adjustedTrades, 0);
});
