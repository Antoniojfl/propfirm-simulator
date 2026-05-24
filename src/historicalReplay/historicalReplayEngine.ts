import { TraceTrade } from '../types';
import { createHistoricalReplayAccount } from './accountLifecycle';
import {
  HistoricalReplayAccount,
  HistoricalReplayEngineInput,
  HistoricalReplayEvent,
  HistoricalReplayResponse,
  HistoricalReplayStrategyInput
} from './types';

interface StrategyCursor {
  evalCursor: number;
  fundedCursor: number;
}

export class HistoricalReplayEngine {
  constructor(private input: HistoricalReplayEngineInput) {}

  public run(options: {
    onProgress?: (current: number, total: number, message: string) => void;
    shouldCancel?: () => void;
  } = {}): HistoricalReplayResponse {
    const strategy = this.input.strategies[0];
    if (!strategy) {
      throw new Error('Historical replay requires one strategy');
    }

    const accountCost = Math.max(0, Number(this.input.request.accountCost ?? this.input.profile.cost));
    const reinvestmentRate = Math.max(0, Math.min(1, Number(this.input.request.reinvestmentPercent ?? 1)));
    const maxReplayTrades = this.maxReplayTrades(strategy);
    const horizonDays = Math.max(1, Number(this.input.request.horizonDays || maxReplayTrades));
    const initialBankroll = Number(this.input.request.initialBankroll || 0);
    const cursor: StrategyCursor = { evalCursor: 0, fundedCursor: 0 };
    const events: HistoricalReplayEvent[] = [];
    const dailyCurve: HistoricalReplayResponse['dailyCurve'] = [];

    let cashBalance = initialBankroll;
    let withdrawnProfit = 0;
    let peakCash = initialBankroll;
    let maxDrawdown = 0;
    let accountsPurchased = 0;
    let accountsBlown = 0;
    let payoutsTaken = 0;
    let grossPayouts = 0;
    let dataExhausted = 0;
    let day = 1;
    let activeAccount: HistoricalReplayAccount | null = null;

    const buyAccount = (purchaseDay: number): HistoricalReplayAccount | null => {
      if (!this.hasRemainingTrades(strategy, cursor)) {
        dataExhausted++;
        events.push(this.systemEvent(purchaseDay, 'DATA_EXHAUSTED', 'No quedan trades originales para crear otra cuenta', cashBalance, withdrawnProfit));
        return null;
      }
      if (cashBalance < accountCost) {
        events.push(this.systemEvent(purchaseDay, 'BANKROLL_DEPLETED', 'Cash insuficiente para comprar otra evaluación', cashBalance, withdrawnProfit));
        return null;
      }

      const accountNumber = ++accountsPurchased;
      cashBalance -= accountCost;
      const preparedStrategy = this.sliceStrategy(strategy, cursor);
      const accountId = `hist-acct${accountNumber}`;
      const account = createHistoricalReplayAccount({
        accountId,
        strategy: strategy.strategy,
        profile: this.input.profile,
        riskProfile: this.input.riskProfile,
        trades: preparedStrategy.trades,
        fundedTrades: preparedStrategy.fundedTrades,
        sanitization: this.input.sanitization
      });

      if (!account.trace.trades.length) {
        dataExhausted++;
        events.push(this.systemEvent(purchaseDay, 'DATA_EXHAUSTED', 'La cuenta no pudo consumir mas trades originales', cashBalance, withdrawnProfit));
        return null;
      }

      this.advanceCursor(strategy, cursor, account);
      events.push({
        day: purchaseDay,
        accountId,
        strategy: strategy.strategy,
        type: 'ACCOUNT_PURCHASED',
        message: `Compra de evaluación para ${strategy.strategy}`,
        amount: -accountCost,
        cashAfter: cashBalance,
        withdrawnProfitAfter: withdrawnProfit,
        totalNetWorthAfter: cashBalance + withdrawnProfit
      });
      return account;
    };

    activeAccount = buyAccount(day);
    while (activeAccount && day <= horizonDays) {
      options.shouldCancel?.();

      const trade = activeAccount.trace.trades[activeAccount.nextTradeIndex];
      if (!trade) {
        dataExhausted++;
        events.push(this.event(day, activeAccount, 'DATA_EXHAUSTED', 'La secuencia original se agotó para esta cuenta', undefined, cashBalance, withdrawnProfit));
        break;
      }

      activeAccount.nextTradeIndex++;
      const tradeCloseEvent = trade.events.find(event => event.type === 'TRADE_CLOSED');
      events.push(this.event(
        day,
        activeAccount,
        'TRADE_CLOSED',
        tradeCloseEvent?.message || `${trade.phase} trade closed`,
        trade.netPnl,
        cashBalance,
        withdrawnProfit,
        trade
      ));
      const payout = this.extractPayout(trade);
      if (payout > 0) {
        grossPayouts += payout;
        payoutsTaken++;
        const reinvested = payout * reinvestmentRate;
        cashBalance += reinvested;
        withdrawnProfit += payout - reinvested;
        events.push(this.event(day, activeAccount, 'PAYOUT_TAKEN', `Payout reinvertido ${this.money(reinvested)}`, reinvested, cashBalance, withdrawnProfit, trade));
      }

      if (trade.events.some(event => event.type === 'EVAL_PASSED')) {
        events.push(this.event(day, activeAccount, 'EVAL_PASSED', 'Evaluación aprobada', undefined, cashBalance, withdrawnProfit, trade));
      }

      const wasBlown = trade.events.some(event => event.type === 'ACCOUNT_BLOWN');
      if (wasBlown) {
        accountsBlown++;
        events.push(this.event(day, activeAccount, 'ACCOUNT_BLOWN', 'Cuenta quemada', undefined, cashBalance, withdrawnProfit, trade));
      }

      peakCash = Math.max(peakCash, cashBalance);
      maxDrawdown = Math.max(maxDrawdown, peakCash - cashBalance);
      dailyCurve.push(this.curvePoint(day, cashBalance, withdrawnProfit, wasBlown ? 0 : 1, accountsPurchased, accountsBlown, payoutsTaken, initialBankroll));
      options.onProgress?.(Math.min(day, horizonDays), horizonDays, `${Math.min(day, horizonDays)}/${horizonDays} dias replay`);

      if (wasBlown) {
        activeAccount = buyAccount(day);
        day++;
        continue;
      }

      const traceCompleted = activeAccount.nextTradeIndex >= activeAccount.trace.trades.length;
      if (traceCompleted) {
        if (!this.hasRemainingTrades(strategy, cursor)) {
          dataExhausted++;
          events.push(this.event(day, activeAccount, 'DATA_EXHAUSTED', 'Se terminó toda la secuencia de trades originales', undefined, cashBalance, withdrawnProfit, trade));
          activeAccount = null;
          break;
        }
        activeAccount = buyAccount(day + 1);
      }

      day++;
    }

    const totalNetWorth = cashBalance + withdrawnProfit;
    const netProfit = totalNetWorth - initialBankroll;
    return {
      horizonDays: Math.min(day, horizonDays),
      accountsPurchased,
      accountsBlown,
      accountCostTotal: accountsPurchased * accountCost,
      payoutsTaken,
      grossPayouts,
      withdrawnProfit,
      cashBalance,
      netProfit,
      roiPercent: initialBankroll > 0 ? (netProfit / initialBankroll) * 100 : 0,
      activeAccounts: activeAccount ? 1 : 0,
      dataExhausted,
      maxDrawdown,
      eventTimeline: events,
      dailyCurve
    };
  }

  private sliceStrategy(strategy: HistoricalReplayStrategyInput, cursor: StrategyCursor): HistoricalReplayStrategyInput {
    return {
      ...strategy,
      trades: strategy.trades.slice(cursor.evalCursor),
      fundedTrades: strategy.fundedTrades?.slice(cursor.fundedCursor)
    };
  }

  private advanceCursor(strategy: HistoricalReplayStrategyInput, cursor: StrategyCursor, account: HistoricalReplayAccount) {
    cursor.evalCursor += account.trace.summary.evalTrades;
    if (strategy.fundedTrades) {
      cursor.fundedCursor += account.trace.summary.fundedTrades;
    } else {
      cursor.evalCursor += account.trace.summary.fundedTrades;
    }
  }

  private hasRemainingTrades(strategy: HistoricalReplayStrategyInput, cursor: StrategyCursor): boolean {
    return cursor.evalCursor < strategy.trades.length;
  }

  private maxReplayTrades(strategy: HistoricalReplayStrategyInput): number {
    return Math.max(1, strategy.trades.length + (strategy.fundedTrades?.length || 0));
  }

  private extractPayout(trade: TraceTrade): number {
    return trade.events
      .filter(event => event.type === 'PAYOUT_TAKEN')
      .reduce((sum, event) => sum + Number(event.value || 0), 0);
  }

  private event(
    day: number,
    account: HistoricalReplayAccount,
    type: HistoricalReplayEvent['type'],
    message: string,
    amount: number | undefined,
    cashBalance: number,
    withdrawnProfit: number,
    trade?: TraceTrade
  ): HistoricalReplayEvent {
    return {
      day,
      date: this.replayDate(day),
      accountId: account.accountId,
      strategy: account.strategy,
      type,
      message,
      amount,
      accountBalance: trade?.balanceAfter,
      accountDrawdownLevel: trade?.drawdownLevel,
      accountHighWaterMark: trade?.highWaterMark,
      tradePnL: trade?.netPnl,
      cashAfter: cashBalance,
      withdrawnProfitAfter: withdrawnProfit,
      totalNetWorthAfter: cashBalance + withdrawnProfit
    };
  }

  private systemEvent(
    day: number,
    type: HistoricalReplayEvent['type'],
    message: string,
    cashBalance: number,
    withdrawnProfit: number
  ): HistoricalReplayEvent {
    return {
      day,
      date: this.replayDate(day),
      type,
      message,
      cashAfter: cashBalance,
      withdrawnProfitAfter: withdrawnProfit,
      totalNetWorthAfter: cashBalance + withdrawnProfit
    };
  }

  private curvePoint(
    day: number,
    cashBalance: number,
    withdrawnProfit: number,
    activeAccounts: number,
    accountsPurchased: number,
    accountsBlown: number,
    payoutsTaken: number,
    initialBankroll: number
  ) {
    const totalNetWorth = cashBalance + withdrawnProfit;
    return {
      day,
      cashBalance,
      withdrawnProfit,
      totalNetWorth,
      netProfit: totalNetWorth - initialBankroll,
      activeAccounts,
      accountsPurchased,
      accountsBlown,
      payoutsTaken
    };
  }

  private money(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  private replayDate(day: number): string {
    const date = new Date(Date.UTC(2020, 0, Math.max(1, day)));
    return date.toISOString().slice(0, 10);
  }
}
