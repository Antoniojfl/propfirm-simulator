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
    const iterations = Math.max(1, Number(this.input.request.iterations || 1000));
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
    const iterations = Math.max(1, Number(this.input.request.iterations || 1000));
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
    const maxDrawdowns = results.map(result => result.maxDrawdown);
    const ruinCount = results.filter(result => result.status === 'RUINED').length;
    const stalledCount = results.filter(result => result.status === 'STALLED').length;

    return {
      iterations,
      horizonDays,
      riskOfRuinPercent: (ruinCount / iterations) * 100,
      stalledPercent: (stalledCount / iterations) * 100,
      medianFinalBankroll: percentile(finalBankrolls, 0.5),
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
          bankrollAfter: bankroll
        });
        curve.push(this.curvePoint(day, bankroll, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken, withdrawnProfit));
        break;
      }

      for (let index = activeAccounts.length - 1; index >= 0; index--) {
        const account = activeAccounts[index];
        const trade = account.trace.trades[account.nextTradeIndex];
        if (!trade) {
          events.push(this.event(day, account, 'DATA_EXHAUSTED', 'No more trades available for this account', undefined, bankroll));
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
          events.push(this.event(day, account, 'PAYOUT_TAKEN', `Payout reinvested ${this.money(reinvested)}`, reinvested, bankroll));
        }

        if (trade.events.some(event => event.type === 'EVAL_PASSED')) {
          events.push(this.event(day, account, 'EVAL_PASSED', 'Evaluation passed', undefined, bankroll));
        }

        if (trade.events.some(event => event.type === 'ACCOUNT_BLOWN')) {
          accountsBlown++;
          events.push(this.event(day, account, 'ACCOUNT_BLOWN', 'Account blown', undefined, bankroll));
          activeAccounts.splice(index, 1);
        } else if (account.nextTradeIndex >= account.trace.trades.length && account.trace.status === 'GRADUATED') {
          activeAccounts.splice(index, 1);
        }
      }

      peakBankroll = Math.max(peakBankroll, bankroll);
      maxDrawdown = Math.max(maxDrawdown, peakBankroll - bankroll);

      if (activeAccounts.length === 0 && bankroll < accountCost) {
        status = bankroll <= 0 ? 'RUINED' : 'STALLED';
        events.push({
          day,
          type: status === 'RUINED' ? 'BANKROLL_RUINED' : 'STALLED',
          message: status === 'RUINED' ? 'Bankroll reached zero or below' : 'No active accounts and not enough bankroll to buy another evaluation',
          bankrollAfter: bankroll
        });
        curve.push(this.curvePoint(day, bankroll, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken, withdrawnProfit));
        break;
      }

      curve.push(this.curvePoint(day, bankroll, activeAccounts.length, accountsPurchased, accountsBlown, payoutsTaken, withdrawnProfit));
    }

    return {
      status,
      finalBankroll: bankroll,
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
    events: BankrollEvent[];
    nextStrategy: () => { strategy: string; trades: any[] };
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
        randomization: {
          mode: this.input.request.randomization?.mode ?? 'random',
          seed: `${this.effectiveSeed}:${input.iteration}:${accountId}:${strategy.strategy}`
        }
      });
      input.activeAccounts.push(lifecycle);
      input.events.push({
        day: input.day,
        accountId,
        strategy: strategy.strategy,
        type: 'ACCOUNT_PURCHASED',
        message: `Purchased evaluation for ${strategy.strategy}`,
        amount: -input.accountCost,
        bankrollAfter: bankrollAfterPurchase
      });
    }
  }

  private extractPayout(trade: TraceTrade): number {
    return trade.events
      .filter(event => event.type === 'PAYOUT_TAKEN')
      .reduce((sum, event) => sum + Number(event.value || 0), 0);
  }

  private event(day: number, account: AccountLifecycle, type: BankrollEvent['type'], message: string, amount: number | undefined, bankroll: number): BankrollEvent {
    return {
      day,
      accountId: account.accountId,
      strategy: account.strategy,
      type,
      message,
      amount,
      bankrollAfter: bankroll
    };
  }

  private curvePoint(
    day: number,
    bankroll: number,
    activeAccounts: number,
    accountsPurchased: number,
    accountsBlown: number,
    payoutsTaken: number,
    withdrawnProfit: number
  ) {
    return {
      day,
      bankroll,
      activeAccounts,
      accountsPurchased,
      accountsBlown,
      payoutsTaken,
      withdrawnProfit
    };
  }

  private money(value: number): string {
    return `$${value.toFixed(2)}`;
  }
}
