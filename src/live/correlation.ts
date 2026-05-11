import { CorrelationCell, DailyPnlPoint } from './types';

export function pearsonCorrelation(
  a: DailyPnlPoint[],
  b: DailyPnlPoint[],
  minOverlapDays = 30
): CorrelationCell {
  const aMap = new Map(a.map(point => [point.date, point.pnl]));
  const pairs: Array<[number, number]> = [];

  for (const point of b) {
    const left = aMap.get(point.date);
    if (left !== undefined) pairs.push([left, point.pnl]);
  }

  if (pairs.length < minOverlapDays) {
    return {
      a: '',
      b: '',
      correlation: null,
      overlapDays: pairs.length,
      insufficientOverlap: true
    };
  }

  const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (const [left, right] of pairs) {
    const leftDiff = left - leftMean;
    const rightDiff = right - rightMean;
    covariance += leftDiff * rightDiff;
    leftVariance += leftDiff ** 2;
    rightVariance += rightDiff ** 2;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);
  const correlation = denominator === 0 ? 0 : covariance / denominator;

  return {
    a: '',
    b: '',
    correlation: Math.max(-1, Math.min(1, correlation)),
    overlapDays: pairs.length,
    insufficientOverlap: false
  };
}
