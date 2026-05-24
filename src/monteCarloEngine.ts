import { AccountMetrics, PropFirmProfile, RandomizationConfig, RiskProfile, SimulationTrace } from './types';
import { RawTrade } from './tradeParser';
import { SimulationEngine } from './simulationEngine';
import { createRunSeed, createSeededRng, Rng } from './random';
import { NormalizedTradeSanitizationConfig } from './tradeSanitizer';

export interface MonteCarloResults {
  firmName: string;
  iterations: number;
  evalPassed: number;
  evalBlown: number;
  fundedAccounts: number;
  fundedAccountsWithPayout: number;
  avgPayoutPerAccount: number;
  expectedValue: number;
  passRatePercent: number;
  payoutRatePercent: number;
  avgDaysToPass: number;
  medianFundedLifespanDays: number;
  accountCycleDays: number;
  expectedValuePerDay: number;
  expectedValuePer30Days: number;
  medianMonthlyReturn: number;
  medianMaxConsecutiveLosses: number;
  avgProfitFactor: number;
  percentAccounts3PlusPayouts: number;
  fundedBlowUpRate: number;
  medianPayoutPerAccount: number;
  avgWinRate: number;
  avgNetPerTrade: number;
  medianTradesToPass: number;
  medianTradesToBlowEval: number;
  medianFundedTrades: number;
  avgEvalWin: number;
  avgEvalLoss: number;
  avgFundedWin: number;
  avgFundedLoss: number;
  avgPayoutsCount: number;
  avgSinglePayoutAmount: number;
  maxPayouts: number;
  avgTacticalTrades: number;
  tacticalWinRateRealized: number;
  avgTacticalPnL: number;
  payoutsUnlockedByTactical: number;
  accountsBlownByTactical: number;
  randomization: {
    mode: 'random' | 'seeded';
    seed: string;
  };
}

export interface MonteCarloRun {
  metrics: MonteCarloResults;
  traces: SimulationTrace[];
}

export class MonteCarloEngine {
  private profile: PropFirmProfile;
  private riskProfile: RiskProfile;
  private rawTrades: RawTrade[];
  private fundedRawTrades?: RawTrade[];
  private iterations: number;
  private randomization: RandomizationConfig;
  private effectiveSeed: string;
  private sanitization?: NormalizedTradeSanitizationConfig;

  constructor(
    profile: PropFirmProfile,
    riskProfile: RiskProfile,
    rawTrades: RawTrade[],
    iterations: number = 1000,
    randomization: RandomizationConfig = { mode: 'random' },
    sanitization?: NormalizedTradeSanitizationConfig,
    fundedRawTrades?: RawTrade[]
  ) {
    this.profile = profile;
    this.riskProfile = riskProfile;
    this.rawTrades = rawTrades;
    this.fundedRawTrades = fundedRawTrades;
    this.iterations = iterations;
    this.randomization = randomization;
    this.effectiveSeed = createRunSeed(randomization.seed);
    this.sanitization = sanitization;
  }

  public getEffectiveSeed(): string {
    return this.effectiveSeed;
  }

  public run(): MonteCarloResults {
    return this.runWithTraces(0).metrics;
  }

  public runWithTraces(traceCount: number = 5): MonteCarloRun {
    let evalPassed = 0;
    let evalBlown = 0;
    let fundedAccountsWithPayout = 0;
    let accountsWith3PlusPayouts = 0;
    let fundedAccountsBlownBeforePayout = 0;
    let totalPayoutsCountAllIterations = 0;
    let maxPayoutsReached = 0;
    let totalPayoutsAmountAllIterations = 0;
    let totalDaysToPass = 0;
    let totalProfitFactor = 0;
    let totalWinRate = 0;
    let totalNetPerTrade = 0;
    let totalEvalGrossWin = 0;
    let totalEvalGrossLoss = 0;
    let totalEvalWinningTrades = 0;
    let totalEvalLosingTrades = 0;
    let totalFundedGrossWin = 0;
    let totalFundedGrossLoss = 0;
    let totalFundedWinningTrades = 0;
    let totalFundedLosingTrades = 0;
    let totalTacticalTrades = 0;
    let totalTacticalWins = 0;
    let totalTacticalPnl = 0;
    let totalPayoutsUnlockedByTactical = 0;
    let totalAccountsBlownByTactical = 0;

    const fundedLifespans: number[] = [];
    const fundedPayoutAmounts: number[] = [];
    const maxConsecutiveLossesArray: number[] = [];
    const tradesToPassArray: number[] = [];
    const tradesToBlowEvalArray: number[] = [];
    const fundedTradesArray: number[] = [];
    const traces: SimulationTrace[] = [];
    const avgTradesPerDay = this.calculateAvgTradesPerDay();

    for (let i = 0; i < this.iterations; i++) {
      const captureTrace = traces.length < traceCount;
      const resampledTrades = this.resampleTrades(this.createIterationRng(i));
      const resampledFundedTrades = this.fundedRawTrades ? this.resampleTrades(this.createFundedIterationRng(i), this.fundedRawTrades) : undefined;
      const simEngine = new SimulationEngine(this.profile, this.riskProfile, resampledTrades, avgTradesPerDay, captureTrace, this.createTacticalRng(i), this.sanitization, resampledFundedTrades);
      const { metrics, trace } = simEngine.run();

      if (trace && traces.length < traceCount) {
        trace.id = `trace-${i + 1}`;
        trace.label = `Sim ${i + 1}`;
        traces.push(trace);
      }

      maxConsecutiveLossesArray.push(metrics.maxConsecutiveLosses);
      totalProfitFactor += Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 0;
      totalWinRate += metrics.winRate;
      totalNetPerTrade += metrics.averageNetPerTrade;
      totalEvalGrossWin += metrics.evalGrossWin;
      totalEvalGrossLoss += metrics.evalGrossLoss;
      totalEvalWinningTrades += metrics.evalWinningTrades;
      totalEvalLosingTrades += (metrics.evalTrades - metrics.evalWinningTrades);
      totalTacticalTrades += metrics.tacticalTrades;
      totalTacticalWins += metrics.tacticalWins;
      totalTacticalPnl += metrics.tacticalPnl;
      totalPayoutsUnlockedByTactical += metrics.payoutsUnlockedByTactical;
      totalAccountsBlownByTactical += metrics.accountsBlownByTactical;

      if (metrics.status === 'BLOWN' && metrics.daysToPass === null) {
        evalBlown++;
        tradesToBlowEvalArray.push(metrics.evalTrades);
      } else {
        this.aggregateFundedMetrics(metrics, {
          tradesToPassArray,
          fundedTradesArray,
          fundedLifespans,
          fundedPayoutAmounts
        });

        evalPassed++;
        totalDaysToPass += metrics.daysToPass || 0;
        totalFundedGrossWin += metrics.fundedGrossWin;
        totalFundedGrossLoss += metrics.fundedGrossLoss;
        totalFundedWinningTrades += metrics.fundedWinningTrades;
        totalFundedLosingTrades += (metrics.fundedTrades - metrics.fundedWinningTrades);

        if (metrics.payoutsTaken > 0) {
          fundedAccountsWithPayout++;
          if (metrics.payoutsTaken >= 3) accountsWith3PlusPayouts++;
          maxPayoutsReached = Math.max(maxPayoutsReached, metrics.payoutsTaken);
        } else {
          fundedAccountsBlownBeforePayout++;
        }

        totalPayoutsCountAllIterations += metrics.payoutsTaken;
        totalPayoutsAmountAllIterations += metrics.totalPayoutAmount;
      }
    }

    const passRatePercent = (evalPassed / this.iterations) * 100;
    const payoutRatePercent = (fundedAccountsWithPayout / this.iterations) * 100;
    const percentAccounts3PlusPayouts = (accountsWith3PlusPayouts / this.iterations) * 100;
    const fundedBlowUpRate = evalPassed > 0 ? (fundedAccountsBlownBeforePayout / evalPassed) * 100 : 0;
    const avgTotalPayout = totalPayoutsAmountAllIterations / this.iterations;
    const expectedValue = avgTotalPayout - this.profile.cost;
    const avgPayoutsCount = fundedAccountsWithPayout > 0 ? totalPayoutsCountAllIterations / fundedAccountsWithPayout : 0;
    const avgSinglePayoutAmount = totalPayoutsCountAllIterations > 0 ? totalPayoutsAmountAllIterations / totalPayoutsCountAllIterations : 0;
    const medianPayoutPerAccount = this.median(fundedPayoutAmounts);
    const avgDaysToPass = evalPassed > 0 ? totalDaysToPass / evalPassed : 0;
    const medianFundedLifespanDays = this.median(fundedLifespans);
    const accountCycleDays = Math.max(1, avgDaysToPass + medianFundedLifespanDays);
    const expectedValuePerDay = expectedValue / accountCycleDays;
    const expectedValuePer30Days = expectedValuePerDay * 30;
    const medianMonthlyReturn = medianFundedLifespanDays > 0 ? (medianPayoutPerAccount / medianFundedLifespanDays) * 30 : 0;

    return {
      metrics: {
        firmName: this.profile.firm_name,
        iterations: this.iterations,
        evalPassed,
        evalBlown,
        fundedAccounts: evalPassed,
        fundedAccountsWithPayout,
        avgPayoutPerAccount: avgTotalPayout,
        expectedValue,
        passRatePercent,
        payoutRatePercent,
        avgDaysToPass,
        medianFundedLifespanDays,
        accountCycleDays,
        expectedValuePerDay,
        expectedValuePer30Days,
        medianMonthlyReturn,
        medianMaxConsecutiveLosses: this.median(maxConsecutiveLossesArray),
        avgProfitFactor: totalProfitFactor / this.iterations,
        percentAccounts3PlusPayouts,
        fundedBlowUpRate,
        medianPayoutPerAccount,
        avgWinRate: totalWinRate / this.iterations,
        avgNetPerTrade: totalNetPerTrade / this.iterations,
        medianTradesToPass: this.median(tradesToPassArray),
        medianTradesToBlowEval: this.median(tradesToBlowEvalArray),
        medianFundedTrades: this.median(fundedTradesArray),
        avgEvalWin: totalEvalWinningTrades > 0 ? totalEvalGrossWin / totalEvalWinningTrades : 0,
        avgEvalLoss: totalEvalLosingTrades > 0 ? totalEvalGrossLoss / totalEvalLosingTrades : 0,
        avgFundedWin: totalFundedWinningTrades > 0 ? totalFundedGrossWin / totalFundedWinningTrades : 0,
        avgFundedLoss: totalFundedLosingTrades > 0 ? totalFundedGrossLoss / totalFundedLosingTrades : 0,
        avgPayoutsCount,
        avgSinglePayoutAmount,
        maxPayouts: maxPayoutsReached,
        avgTacticalTrades: totalTacticalTrades / this.iterations,
        tacticalWinRateRealized: totalTacticalTrades > 0 ? (totalTacticalWins / totalTacticalTrades) * 100 : 0,
        avgTacticalPnL: totalTacticalPnl / this.iterations,
        payoutsUnlockedByTactical: totalPayoutsUnlockedByTactical,
        accountsBlownByTactical: totalAccountsBlownByTactical,
        randomization: {
          mode: this.randomization.mode,
          seed: this.effectiveSeed
        }
      },
      traces
    };
  }

  public async runWithTracesProgressive(
    traceCount: number = 5,
    options: {
      yieldEvery?: number;
      onProgress?: (iteration: number, total: number) => void;
      shouldCancel?: () => boolean;
    } = {}
  ): Promise<MonteCarloRun> {
    let evalPassed = 0;
    let evalBlown = 0;
    let fundedAccountsWithPayout = 0;
    let accountsWith3PlusPayouts = 0;
    let fundedAccountsBlownBeforePayout = 0;
    let totalPayoutsCountAllIterations = 0;
    let maxPayoutsReached = 0;
    let totalPayoutsAmountAllIterations = 0;
    let totalDaysToPass = 0;
    let totalProfitFactor = 0;
    let totalWinRate = 0;
    let totalNetPerTrade = 0;
    let totalEvalGrossWin = 0;
    let totalEvalGrossLoss = 0;
    let totalEvalWinningTrades = 0;
    let totalEvalLosingTrades = 0;
    let totalFundedGrossWin = 0;
    let totalFundedGrossLoss = 0;
    let totalFundedWinningTrades = 0;
    let totalFundedLosingTrades = 0;
    let totalTacticalTrades = 0;
    let totalTacticalWins = 0;
    let totalTacticalPnl = 0;
    let totalPayoutsUnlockedByTactical = 0;
    let totalAccountsBlownByTactical = 0;

    const fundedLifespans: number[] = [];
    const fundedPayoutAmounts: number[] = [];
    const maxConsecutiveLossesArray: number[] = [];
    const tradesToPassArray: number[] = [];
    const tradesToBlowEvalArray: number[] = [];
    const fundedTradesArray: number[] = [];
    const traces: SimulationTrace[] = [];
    const avgTradesPerDay = this.calculateAvgTradesPerDay();
    const yieldEvery = Math.max(1, options.yieldEvery ?? 10);

    for (let i = 0; i < this.iterations; i++) {
      if (options.shouldCancel?.()) throw new Error('Run cancelled');
      const captureTrace = traces.length < traceCount;
      const resampledTrades = this.resampleTrades(this.createIterationRng(i));
      const resampledFundedTrades = this.fundedRawTrades ? this.resampleTrades(this.createFundedIterationRng(i), this.fundedRawTrades) : undefined;
      const simEngine = new SimulationEngine(this.profile, this.riskProfile, resampledTrades, avgTradesPerDay, captureTrace, this.createTacticalRng(i), this.sanitization, resampledFundedTrades);
      const { metrics, trace } = simEngine.run();

      if (trace && traces.length < traceCount) {
        trace.id = `trace-${i + 1}`;
        trace.label = `Sim ${i + 1}`;
        traces.push(trace);
      }

      maxConsecutiveLossesArray.push(metrics.maxConsecutiveLosses);
      totalProfitFactor += Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 0;
      totalWinRate += metrics.winRate;
      totalNetPerTrade += metrics.averageNetPerTrade;
      totalEvalGrossWin += metrics.evalGrossWin;
      totalEvalGrossLoss += metrics.evalGrossLoss;
      totalEvalWinningTrades += metrics.evalWinningTrades;
      totalEvalLosingTrades += (metrics.evalTrades - metrics.evalWinningTrades);
      totalTacticalTrades += metrics.tacticalTrades;
      totalTacticalWins += metrics.tacticalWins;
      totalTacticalPnl += metrics.tacticalPnl;
      totalPayoutsUnlockedByTactical += metrics.payoutsUnlockedByTactical;
      totalAccountsBlownByTactical += metrics.accountsBlownByTactical;

      if (metrics.status === 'BLOWN' && metrics.daysToPass === null) {
        evalBlown++;
        tradesToBlowEvalArray.push(metrics.evalTrades);
      } else {
        this.aggregateFundedMetrics(metrics, {
          tradesToPassArray,
          fundedTradesArray,
          fundedLifespans,
          fundedPayoutAmounts
        });

        evalPassed++;
        totalDaysToPass += metrics.daysToPass || 0;
        totalFundedGrossWin += metrics.fundedGrossWin;
        totalFundedGrossLoss += metrics.fundedGrossLoss;
        totalFundedWinningTrades += metrics.fundedWinningTrades;
        totalFundedLosingTrades += (metrics.fundedTrades - metrics.fundedWinningTrades);

        if (metrics.payoutsTaken > 0) {
          fundedAccountsWithPayout++;
          if (metrics.payoutsTaken >= 3) accountsWith3PlusPayouts++;
          maxPayoutsReached = Math.max(maxPayoutsReached, metrics.payoutsTaken);
        } else {
          fundedAccountsBlownBeforePayout++;
        }

        totalPayoutsCountAllIterations += metrics.payoutsTaken;
        totalPayoutsAmountAllIterations += metrics.totalPayoutAmount;
      }

      options.onProgress?.(i + 1, this.iterations);
      if ((i + 1) % yieldEvery === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const passRatePercent = (evalPassed / this.iterations) * 100;
    const payoutRatePercent = (fundedAccountsWithPayout / this.iterations) * 100;
    const percentAccounts3PlusPayouts = (accountsWith3PlusPayouts / this.iterations) * 100;
    const fundedBlowUpRate = evalPassed > 0 ? (fundedAccountsBlownBeforePayout / evalPassed) * 100 : 0;
    const avgTotalPayout = totalPayoutsAmountAllIterations / this.iterations;
    const expectedValue = avgTotalPayout - this.profile.cost;
    const avgPayoutsCount = fundedAccountsWithPayout > 0 ? totalPayoutsCountAllIterations / fundedAccountsWithPayout : 0;
    const avgSinglePayoutAmount = totalPayoutsCountAllIterations > 0 ? totalPayoutsAmountAllIterations / totalPayoutsCountAllIterations : 0;
    const medianPayoutPerAccount = this.median(fundedPayoutAmounts);
    const avgDaysToPass = evalPassed > 0 ? totalDaysToPass / evalPassed : 0;
    const medianFundedLifespanDays = this.median(fundedLifespans);
    const accountCycleDays = Math.max(1, avgDaysToPass + medianFundedLifespanDays);
    const expectedValuePerDay = expectedValue / accountCycleDays;
    const expectedValuePer30Days = expectedValuePerDay * 30;
    const medianMonthlyReturn = medianFundedLifespanDays > 0 ? (medianPayoutPerAccount / medianFundedLifespanDays) * 30 : 0;

    return {
      metrics: {
        firmName: this.profile.firm_name,
        iterations: this.iterations,
        evalPassed,
        evalBlown,
        fundedAccounts: evalPassed,
        fundedAccountsWithPayout,
        avgPayoutPerAccount: avgTotalPayout,
        expectedValue,
        passRatePercent,
        payoutRatePercent,
        avgDaysToPass,
        medianFundedLifespanDays,
        accountCycleDays,
        expectedValuePerDay,
        expectedValuePer30Days,
        medianMonthlyReturn,
        medianMaxConsecutiveLosses: this.median(maxConsecutiveLossesArray),
        avgProfitFactor: totalProfitFactor / this.iterations,
        percentAccounts3PlusPayouts,
        fundedBlowUpRate,
        medianPayoutPerAccount,
        avgWinRate: totalWinRate / this.iterations,
        avgNetPerTrade: totalNetPerTrade / this.iterations,
        medianTradesToPass: this.median(tradesToPassArray),
        medianTradesToBlowEval: this.median(tradesToBlowEvalArray),
        medianFundedTrades: this.median(fundedTradesArray),
        avgEvalWin: totalEvalWinningTrades > 0 ? totalEvalGrossWin / totalEvalWinningTrades : 0,
        avgEvalLoss: totalEvalLosingTrades > 0 ? totalEvalGrossLoss / totalEvalLosingTrades : 0,
        avgFundedWin: totalFundedWinningTrades > 0 ? totalFundedGrossWin / totalFundedWinningTrades : 0,
        avgFundedLoss: totalFundedLosingTrades > 0 ? totalFundedGrossLoss / totalFundedLosingTrades : 0,
        avgPayoutsCount,
        avgSinglePayoutAmount,
        maxPayouts: maxPayoutsReached,
        avgTacticalTrades: totalTacticalTrades / this.iterations,
        tacticalWinRateRealized: totalTacticalTrades > 0 ? (totalTacticalWins / totalTacticalTrades) * 100 : 0,
        avgTacticalPnL: totalTacticalPnl / this.iterations,
        payoutsUnlockedByTactical: totalPayoutsUnlockedByTactical,
        accountsBlownByTactical: totalAccountsBlownByTactical,
        randomization: {
          mode: this.randomization.mode,
          seed: this.effectiveSeed
        }
      },
      traces
    };
  }

  public buildTraces(count: number = 5): SimulationTrace[] {
    const avgTradesPerDay = this.calculateAvgTradesPerDay();
    const traces: SimulationTrace[] = [];
    for (let i = 0; i < count; i++) {
      const resampledTrades = this.resampleTrades(this.createIterationRng(i));
      const resampledFundedTrades = this.fundedRawTrades ? this.resampleTrades(this.createFundedIterationRng(i), this.fundedRawTrades) : undefined;
      const simEngine = new SimulationEngine(this.profile, this.riskProfile, resampledTrades, avgTradesPerDay, true, this.createTacticalRng(i), this.sanitization, resampledFundedTrades);
      const { trace } = simEngine.run();
      if (trace) {
        trace.id = `trace-${i + 1}`;
        trace.label = `Sim ${i + 1}`;
        traces.push(trace);
      }
    }
    return traces;
  }

  private aggregateFundedMetrics(metrics: AccountMetrics, arrays: {
    tradesToPassArray: number[];
    fundedTradesArray: number[];
    fundedLifespans: number[];
    fundedPayoutAmounts: number[];
  }) {
    arrays.tradesToPassArray.push(metrics.evalTrades);
    arrays.fundedTradesArray.push(metrics.fundedTrades);
    if (metrics.fundedLifespanDays !== null) arrays.fundedLifespans.push(metrics.fundedLifespanDays);
    if (metrics.payoutsTaken > 0) arrays.fundedPayoutAmounts.push(metrics.totalPayoutAmount);
  }

  private createIterationRng(iteration: number): Rng {
    return createSeededRng(`${this.effectiveSeed}:${iteration}`);
  }

  private createTacticalRng(iteration: number): Rng {
    return createSeededRng(`${this.effectiveSeed}:${iteration}:tactical`);
  }

  private createFundedIterationRng(iteration: number): Rng {
    return createSeededRng(`${this.effectiveSeed}:${iteration}:funded`);
  }

  private resampleTrades(rng: Rng, sourceTrades: RawTrade[] = this.rawTrades): RawTrade[] {
    const resampled: RawTrade[] = [];
    const n = sourceTrades.length;
    if (n === 0) return resampled;

    const firstTime = sourceTrades[0].openTime.getTime();
    const lastTime = sourceTrades[n - 1].openTime.getTime();
    const totalDurationMs = Math.max(lastTime - firstTime, 24 * 3600 * 1000);
    const avgTimeBetweenTradesMs = Math.max(totalDurationMs / n, 24 * 3600 * 1000);
    let currentSimulatedTime = firstTime;

    for (let i = 0; i < n; i++) {
      const randomIndex = Math.floor(rng() * n);
      const originalTrade = sourceTrades[randomIndex];
      const tradeDuration = originalTrade.closeTime.getTime() - originalTrade.openTime.getTime();
      resampled.push({
        ...originalTrade,
        ticket: `${originalTrade.ticket}-${i + 1}`,
        openTime: new Date(currentSimulatedTime),
        closeTime: new Date(currentSimulatedTime + Math.max(tradeDuration, 0))
      });
      currentSimulatedTime += avgTimeBetweenTradesMs;
    }

    return resampled;
  }

  private calculateAvgTradesPerDay(): number {
    if (this.rawTrades.length <= 1) return 1;
    const firstDate = this.rawTrades[0].openTime.getTime();
    const lastDate = this.rawTrades[this.rawTrades.length - 1].closeTime.getTime();
    const totalDays = (lastDate - firstDate) / (1000 * 3600 * 24);
    return this.rawTrades.length / Math.max(totalDays, 1);
  }

  private median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[half - 1] + sorted[half]) / 2 : sorted[half];
  }
}
