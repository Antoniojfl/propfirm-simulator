import { RawTrade } from './tradeParser';
import { SimulationPhase, TradeSanitizationConfig } from './types';

export interface PhaseSanitizationValues {
  maxWinPoints: number;
  maxLossPoints: number;
}

export interface NormalizedTradeSanitizationConfig {
  mode: 'raw' | 'fixedOutcome';
  maxWinPoints: number;
  maxLossPoints: number;
  evaluation: PhaseSanitizationValues;
  funded: PhaseSanitizationValues;
  phaseSpecific: boolean;
}

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
    const sanitizedTrade = sanitizeTradeForPhase(trade, normalized, 'evaluation');
    const originalPoints = Number(trade.netPoints || 0);
    const snappedPoints = sanitizedTrade.netPoints;
    if (snappedPoints === originalPoints) return trade;
    adjustedTrades++;
    if (originalPoints > 0) positiveAdjustedTrades++;
    if (originalPoints < 0) negativeAdjustedTrades++;
    return sanitizedTrade;
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

export function sanitizeTradeForPhase(
  trade: RawTrade,
  config: TradeSanitizationConfig | NormalizedTradeSanitizationConfig | undefined,
  phase: SimulationPhase
): RawTrade {
  const normalized = isNormalized(config) ? config : normalizeSanitizationConfig(config);
  if (normalized.mode !== 'fixedOutcome') return trade;

  const phaseConfig = phase === 'funded' ? normalized.funded : normalized.evaluation;
  const originalPoints = Number(trade.netPoints || 0);
  const snappedPoints = originalPoints > 0
    ? phaseConfig.maxWinPoints
    : originalPoints < 0
      ? -phaseConfig.maxLossPoints
      : 0;

  if (snappedPoints === originalPoints) return trade;
  return {
    ...trade,
    netPoints: snappedPoints,
    rawPnl: scaleRawPnl(trade.rawPnl, originalPoints, snappedPoints)
  };
}

export function normalizeSanitizationConfig(config?: TradeSanitizationConfig): NormalizedTradeSanitizationConfig {
  const mode = config?.mode === 'fixedOutcome' ? 'fixedOutcome' : 'raw';
  const maxWinPoints = positiveNumber(config?.maxWinPoints, 84);
  const maxLossPoints = positiveNumber(config?.maxLossPoints, 84);
  const evaluation = {
    maxWinPoints: positiveNumber(config?.evaluation?.maxWinPoints, maxWinPoints),
    maxLossPoints: positiveNumber(config?.evaluation?.maxLossPoints, maxLossPoints)
  };
  const funded = {
    maxWinPoints: positiveNumber(config?.funded?.maxWinPoints, maxWinPoints),
    maxLossPoints: positiveNumber(config?.funded?.maxLossPoints, maxLossPoints)
  };
  return {
    mode,
    maxWinPoints,
    maxLossPoints,
    evaluation,
    funded,
    phaseSpecific: evaluation.maxWinPoints !== funded.maxWinPoints || evaluation.maxLossPoints !== funded.maxLossPoints
  };
}

function rawReport(totalTrades: number, config: NormalizedTradeSanitizationConfig): TradeSanitizationReport {
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

function isNormalized(config: TradeSanitizationConfig | NormalizedTradeSanitizationConfig | undefined): config is NormalizedTradeSanitizationConfig {
  return Boolean(config && 'evaluation' in config && 'funded' in config && 'phaseSpecific' in config);
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function scaleRawPnl(rawPnl: number, originalPoints: number, snappedPoints: number): number {
  if (!Number.isFinite(rawPnl)) return rawPnl;
  if (originalPoints === 0) return rawPnl;
  return rawPnl * (snappedPoints / originalPoints);
}
