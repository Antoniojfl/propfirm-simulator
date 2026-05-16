import { RawTrade } from './tradeParser';
import { TradeSanitizationConfig } from './types';

export interface TradeSanitizationReport {
  mode: 'raw' | 'fixedOutcome';
  totalTrades: number;
  adjustedTrades: number;
  positiveAdjustedTrades: number;
  negativeAdjustedTrades: number;
  maxWinPoints: number | null;
  maxLossPoints: number | null;
}

export interface TradeSanitizationResult {
  trades: RawTrade[];
  report: TradeSanitizationReport;
}

export function sanitizeTrades(trades: RawTrade[], config?: TradeSanitizationConfig): TradeSanitizationResult {
  const normalized = normalizeSanitizationConfig(config);
  if (normalized.mode !== 'fixedOutcome') {
    return {
      trades,
      report: rawReport(trades.length, normalized)
    };
  }

  let adjustedTrades = 0;
  let positiveAdjustedTrades = 0;
  let negativeAdjustedTrades = 0;

  const sanitized = trades.map(trade => {
    const originalPoints = Number(trade.netPoints || 0);
    const snappedPoints = originalPoints > 0
      ? normalized.maxWinPoints
      : originalPoints < 0
        ? -normalized.maxLossPoints
        : 0;

    if (snappedPoints === originalPoints) return trade;
    adjustedTrades++;
    if (originalPoints > 0) positiveAdjustedTrades++;
    if (originalPoints < 0) negativeAdjustedTrades++;

    return {
      ...trade,
      netPoints: snappedPoints,
      rawPnl: scaleRawPnl(trade.rawPnl, originalPoints, snappedPoints)
    };
  });

  return {
    trades: sanitized,
    report: {
      mode: 'fixedOutcome',
      totalTrades: trades.length,
      adjustedTrades,
      positiveAdjustedTrades,
      negativeAdjustedTrades,
      maxWinPoints: normalized.maxWinPoints,
      maxLossPoints: normalized.maxLossPoints
    }
  };
}

export function normalizeSanitizationConfig(config?: TradeSanitizationConfig): Required<TradeSanitizationConfig> {
  const mode = config?.mode === 'fixedOutcome' ? 'fixedOutcome' : 'raw';
  return {
    mode,
    maxWinPoints: Math.max(0, Number(config?.maxWinPoints ?? 82.5)),
    maxLossPoints: Math.max(0, Number(config?.maxLossPoints ?? 82.5))
  };
}

function rawReport(totalTrades: number, config: Required<TradeSanitizationConfig>): TradeSanitizationReport {
  return {
    mode: config.mode,
    totalTrades,
    adjustedTrades: 0,
    positiveAdjustedTrades: 0,
    negativeAdjustedTrades: 0,
    maxWinPoints: config.maxWinPoints,
    maxLossPoints: config.maxLossPoints
  };
}

function scaleRawPnl(rawPnl: number, originalPoints: number, snappedPoints: number): number {
  if (!Number.isFinite(rawPnl)) return rawPnl;
  if (originalPoints === 0) return rawPnl;
  return rawPnl * (snappedPoints / originalPoints);
}
