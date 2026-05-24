import { createRunSeed, createSeededRng } from '../random';
import { TraceTrade } from '../types';
import { createAccountLifecycle } from './accountLifecycle';
import { average, percentile } from './scoring';
import {
  AccountLifecycle,
  BankrollEngineInput,
  BankrollEvent,
  BankrollIterationResult,
  BankrollResponse
} from './types';

export class BankrollEngine {
  private effectiveSeed: string;

  constructor(private input: BankrollEngineInput) {
    this.effectiveSeed = createRunSeed(input.request.randomization?.seed);
  }

  public run(): BankrollResponse {
    const iterations = this.iterations();
    const horizonDays = Math.max(1, Math.round(Number(this.input.request.horizonMonths || 12) * 21));
    const results: BankrollIterationResult[] = [];

    for (let i = 0; i < iterations; i++) {
      results.push(this.runIteration(i, horizonDays));
    }

    return this.buildResponse(results, iterations, horizonDays);
  }

  public async runProgressive(options: {
    onProgress?: (current: number, total: number) => void;
  } = {}): Promise<BankrollResponse> {
    const iterations = this.iterations();
    const horizonDays = Math.max(1, Math.round(Number(this.input.request.horizonMonths || 12) * 21));
    const results: BankrollIterationResult[] = [];

    for (let i = 0; i < iterations; i++) {
      options.onProgress?.(i, iterations);
      results.push(this.runIteration(i, horizonDays));
      if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    options.onProgress?.(iterations, iterations);

    return this.buildResponse(results, iterations, horizonDays);
  }

  private buildResponse(results: BankrollIterationResult[], iterations: number, horizonDays: number): BankrollResponse {
    const finalBankrolls = results.map(result => result.finalBankroll);
    const deployableBankrolls = results.map(result => result.finalDeployableBankroll);
    const surplusProfits = results.map(result => result.finalSurplusProfit);
    const reserveCoveragePercents = results.map(result => result.finalReserveCoveragePercent);
    const withdrawnProfits = results.map(result => result.finalWithdrawnProfit);
    const totalNetWorths = results.map(result => result.finalTotalNetWorth);
    const netProfits = results.map(result => result.finalNetProfit);
    const roiPercents = results.map(result => result.roiPercent);
    const maxDrawdowns = results.map(result => result.maxDrawdown);
    const ruinCount = results.filter(result => result.status === 'RUINED').length;
    const stalledCount = results.filter(result => result.status === 'STALLED').length;

    return {
      iterations,
      horizonDays,
      riskOfRuinPercent: (ruinCount / iterations) * 100,
      stalledPercent: (stalledCount / iterations) * 100,
      medianFinalBankroll: percentile(finalBankrolls, 0.5),
      medianOperatingBankroll: percentile(finalBankrolls, 0.5),
      operatingReserveTarget: this.operatingReserveTarget(),
      medianDeployableBankroll: percentile(deployableBankrolls, 0.5),
      medianSurplusProfit: percentile(surplusProfits, 0.5),
      p10SurplusProfit: percentile(surplusProfits, 0.1),
      p90SurplusProfit: percentile(surplusProfits, 0.9),
      medianReserveCoveragePercent: percentile(reserveCoveragePercents, 0.5),
      p10OperatingBankroll: percentile(finalBankrolls, 0.1),
      p90OperatingBankroll: percentile(finalBankrolls, 0.9),
      medianWithdrawnProfit: percentile(withdrawnProfits, 0.5),
      medianTotalNetWorth: percentile(totalNetWorths, 0.5),
      medianNetProfit: percentile(netProfits, 0.5),
      medianROIPercent: percentile(roiPercents, 0.5),
      p10FinalBankroll: percentile(finalBankrolls, 0.1),
      p90FinalBankroll: percentile(finalBankrolls, 0.9),
      medianMaxDrawdown: percentile(maxDrawdowns, 0.5),
      avgPayouts: average(results.map(result => result.payoutsTaken)),
      avgAccountsPurchased: average(results.map(result => result.accountsPurchased)),
      avgAccountsBlown: average(results.map(result => result.accountsBlown)),
      avgWithdrawnProfit: average(results.map(result => result.withdrawnProfit)),
      representativeCurves: results.slice(0, 5).map((result, index) => ({
        id: `curve-${index + 1}`,
        status: result.status,
        finalBankroll: result.finalBankroll,
        finalDeployableBankroll: result.finalDeployableBankroll,
        finalSurplusProfit: result.finalSurplusProfit,
        finalReserveCoveragePercent: result.finalReserveCoveragePercent,
        finalWithdrawnProfit: result.finalWithdrawnProfit,
        finalTotalNetWorth: result.finalTotalNetWorth,
        finalNetProfit: result.finalNetProfit,
        maxDrawdown: result.maxDrawdown,
        curve: result.curve,
        events: result.events.slice(0, 120)
      })),
      eventSamples: results.flatMap(result => result.events).slice(0, 250)
    };
  }

  private runIteration(iteration: number, horizonDays: number): BankrollIterationResult {
    const request = this.input.request;
    const accountCost = Math.max(0, this.input.profile.cost);
    const maxActiveAccounts = Math.max(1, Number(request.maxActiveAccountsPerDay || 3));
    const reinvestmentRate = Math.max(0, Math.min(1, Number(request.reinvestmentPercent ?? 1)));
    const reserveTarget = this.operatingReserveTarget();
    const rng = createSeededRng(`${this.effectiveSeed}:bankroll:${iteration}`);
    let strategyCursor = Math.floor(rng() * this.input.strategies.length);
    let bankroll = Number(request.initialBankroll || 0);
    let peakBankroll = bankroll;
    let maxDrawdown = 0;
    let accountsPurchased = 0;
    let accountsBlown = 0;
    let payoutsTaken = 0;
    let withdrawnProfit = 0;
    let status: BankrollIterationResult['status'] = 'COMPLETED';
    const activeAccounts: AccountLifecycle[] = [];
    const curve: BankrollIterationResult['curve'] = [];
    const events: BankrollEvent[] = [];

    for (let day = 1; day <= horizonDays; day++) {
      this.fillSlots({
        day,
        activeAccounts,
        maxActiveAccounts,
        accountCost,
        bankrollRef: value => { bankroll = value; },
        getBankroll: () => bankroll,
        getWithdrawnProfit: () => withdrawnProfit,
        events,
        nextStrategy: () => {
          const strategy = this.input.strategies[strategyCursor % this.input.strategies.length];
          strategyCursor++;
          return strategy;
        },
        accountIndex: () => ++accountsPurchased,
        iteration
      });

      if (bankroll <= 0) {
        status = 'RUINED';
        events.push({
          day,
          type: 'BANKROLL_RUINED',
          message: 'Bankroll reached zero or below',
          amount: bankroll,
          bankrollAfter: bankroll,
          withdrawnProfitAfter: withdrawnProfit,
          totalNetWorthAfter: bankroll + withdrawnProfit
        });
        curve.push(this.curvePoint(day, bankroll, withdrawnProfit, reserveTarget, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken));
        break;
      }

      for (let index = activeAccounts.length - 1; index >= 0; index--) {
        const account = activeAccounts[index];
        const trade = account.trace.trades[account.nextTradeIndex];
        if (!trade) {
          events.push(this.event(day, account, 'DATA_EXHAUSTED', 'No more trades available for this account', undefined, bankroll, withdrawnProfit));
          activeAccounts.splice(index, 1);
          continue;
        }

        account.nextTradeIndex++;
        const payout = this.extractPayout(trade);
        if (payout > 0) {
          const reinvested = payout * reinvestmentRate;
          bankroll += reinvested;
          withdrawnProfit += payout - reinvested;
          payoutsTaken++;
          events.push(this.event(day, account, 'PAYOUT_TAKEN', `Payout reinvested ${this.money(reinvested)}`, reinvested, bankroll, withdrawnProfit));
        }

        if (trade.events.some(event => event.type === 'EVAL_PASSED')) {
          events.push(this.event(day, account, 'EVAL_PASSED', 'Evaluation passed', undefined, bankroll, withdrawnProfit));
        }

        if (trade.events.some(event => event.type === 'ACCOUNT_BLOWN')) {
          accountsBlown++;
          events.push(this.event(day, account, 'ACCOUNT_BLOWN', 'Account blown', undefined, bankroll, withdrawnProfit));
          activeAccounts.splice(index, 1);
          this.fillSlots({
            day,
            activeAccounts,
            maxActiveAccounts,
            accountCost,
            bankrollRef: value => { bankroll = value; },
            getBankroll: () => bankroll,
            getWithdrawnProfit: () => withdrawnProfit,
            events,
            nextStrategy: () => {
              const strategy = this.input.strategies[strategyCursor % this.input.strategies.length];
              strategyCursor++;
              return strategy;
            },
            accountIndex: () => ++accountsPurchased,
            iteration
          });
        } else if (account.nextTradeIndex >= account.trace.trades.length && account.trace.status === 'GRADUATED') {
          activeAccounts.splice(index, 1);
        }
      }

      this.fillSlots({
        day,
        activeAccounts,
        maxActiveAccounts,
        accountCost,
        bankrollRef: value => { bankroll = value; },
        getBankroll: () => bankroll,
        getWithdrawnProfit: () => withdrawnProfit,
        events,
        nextStrategy: () => {
          const strategy = this.input.strategies[strategyCursor % this.input.strategies.length];
          strategyCursor++;
          return strategy;
        },
        accountIndex: () => ++accountsPurchased,
        iteration
      });

      peakBankroll = Math.max(peakBankroll, bankroll);
      maxDrawdown = Math.max(maxDrawdown, peakBankroll - bankroll);

      if (activeAccounts.length === 0 && bankroll < accountCost) {
        status = bankroll <= 0 ? 'RUINED' : 'STALLED';
        events.push({
          day,
          type: status === 'RUINED' ? 'BANKROLL_RUINED' : 'STALLED',
          message: status === 'RUINED' ? 'Bankroll reached zero or below' : 'No active accounts and not enough bankroll to buy another evaluation',
          bankrollAfter: bankroll,
          withdrawnProfitAfter: withdrawnProfit,
          totalNetWorthAfter: bankroll + withdrawnProfit
        });
        curve.push(this.curvePoint(day, bankroll, withdrawnProfit, reserveTarget, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken));
        break;
      }

      curve.push(this.curvePoint(day, bankroll, withdrawnProfit, reserveTarget, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken));
    }

    const finalTotalNetWorth = bankroll + withdrawnProfit;
    const initialBankroll = Number(request.initialBankroll || 0);
    const finalNetProfit = finalTotalNetWorth - initialBankroll;
    const roiPercent = initialBankroll > 0 ? (finalNetProfit / initialBankroll) * 100 : 0;
    const finalDeployableBankroll = this.deployableBankroll(bankroll, reserveTarget);
    const finalSurplusProfit = this.surplusProfit(bankroll, withdrawnProfit, reserveTarget);
    const finalReserveCoveragePercent = this.reserveCoveragePercent(bankroll, reserveTarget);

    return {
      status,
      finalBankroll: bankroll,
      finalDeployableBankroll,
      finalSurplusProfit,
      finalReserveCoveragePercent,
      finalWithdrawnProfit: withdrawnProfit,
      finalTotalNetWorth,
      finalNetProfit,
      roiPercent,
      maxDrawdown,
      payoutsTaken,
      accountsPurchased,
      accountsBlown,
      withdrawnProfit,
      curve,
      events
    };
  }

  private fillSlots(input: {
    day: number;
    activeAccounts: AccountLifecycle[];
    maxActiveAccounts: number;
    accountCost: number;
    bankrollRef: (value: number) => void;
    getBankroll: () => number;
    getWithdrawnProfit: () => number;
    events: BankrollEvent[];
    nextStrategy: () => { strategy: string; fundedStrategy?: string; trades: any[]; fundedTrades?: any[] };
    accountIndex: () => number;
    iteration: number;
  }) {
    while (input.activeAccounts.length < input.maxActiveAccounts && input.getBankroll() >= input.accountCost) {
      const accountNumber = input.accountIndex();
      const strategy = input.nextStrategy();
      const bankrollAfterPurchase = input.getBankroll() - input.accountCost;
      input.bankrollRef(bankrollAfterPurchase);
      const accountId = `it${input.iteration + 1}-acct${accountNumber}`;
      const lifecycle = createAccountLifecycle({
        accountId,
        strategy: strategy.strategy,
        profile: this.input.profile,
        riskProfile: this.input.riskProfile,
        trades: strategy.trades,
        fundedTrades: strategy.fundedTrades,
        randomization: {
          mode: this.input.request.randomization?.mode ?? 'random',
          seed: `${this.effectiveSeed}:${input.iteration}:${accountId}:${strategy.strategy}`
        },
        sanitization: this.input.sanitization
      });
      input.activeAccounts.push(lifecycle);
      const withdrawnProfit = input.getWithdrawnProfit();
      input.events.push({
        day: input.day,
        accountId,
        strategy: strategy.strategy,
        type: 'ACCOUNT_PURCHASED',
        message: `Purchased evaluation for ${strategy.strategy}`,
        amount: -input.accountCost,
        bankrollAfter: bankrollAfterPurchase,
        withdrawnProfitAfter: withdrawnProfit,
        totalNetWorthAfter: bankrollAfterPurchase + withdrawnProfit
      });
    }
  }

  private iterations(): number {
    return Math.max(1, Number(this.input.request.iterations || 1000));
  }

  private extractPayout(trade: TraceTrade): number {
    return trade.events
      .filter(event => event.type === 'PAYOUT_TAKEN')
      .reduce((sum, event) => sum + Number(event.value || 0), 0);
  }

  private event(day: number, account: AccountLifecycle, type: BankrollEvent['type'], message: string, amount: number | undefined, bankroll: number, withdrawnProfit: number): BankrollEvent {
    return {
      day,
      accountId: account.accountId,
      strategy: account.strategy,
      type,
      message,
      amount,
      bankrollAfter: bankroll,
      withdrawnProfitAfter: withdrawnProfit,
      totalNetWorthAfter: bankroll + withdrawnProfit
    };
  }

  private curvePoint(
    day: number,
    bankroll: number,
    withdrawnProfit: number,
    reserveTarget: number,
    activeAccounts: number,
    accountsPurchased: number,
    accountsBlown: number,
    payoutsTaken: number
  ) {
    const initialBankroll = Number(this.input.request.initialBankroll || 0);
    const totalNetWorth = bankroll + withdrawnProfit;
    return {
      day,
      bankroll,
      deployableBankroll: this.deployableBankroll(bankroll, reserveTarget),
      surplusProfit: this.surplusProfit(bankroll, withdrawnProfit, reserveTarget),
      reserveCoveragePercent: this.reserveCoveragePercent(bankroll, reserveTarget),
      withdrawnProfit,
      totalNetWorth,
      netProfit: totalNetWorth - initialBankroll,
      activeAccounts,
      accountsPurchased,
      accountsBlown,
      payoutsTaken
    };
  }

  private operatingReserveTarget(): number {
    const configured = Number(this.input.request.operatingReserveTarget);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    return Math.max(0, Number(this.input.request.initialBankroll || 0));
  }

  private deployableBankroll(bankroll: number, reserveTarget: number): number {
    return Math.max(0, Math.min(bankroll, reserveTarget));
  }

  private surplusProfit(bankroll: number, withdrawnProfit: number, reserveTarget: number): number {
    return Math.max(0, bankroll - reserveTarget) + withdrawnProfit;
  }

  private reserveCoveragePercent(bankroll: number, reserveTarget: number): number {
    if (reserveTarget <= 0) return 100;
    return (this.deployableBankroll(bankroll, reserveTarget) / reserveTarget) * 100;
  }

  private money(value: number): string {
    return `$${value.toFixed(2)}`;
  }
}
