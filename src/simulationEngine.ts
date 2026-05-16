import {
  AccountMetrics,
  AccountState,
  DrawdownRule,
  PhaseRules,
  PropFirmProfile,
  PayoutRules,
  RiskProfile,
  SimulationPhase,
  SimulationRunResult,
  SimulationTrace,
  TraceEvent,
  TraceTrade
} from './types';
import { RawTrade } from './tradeParser';
import { contractLimitForRules, getPhaseRiskConfig, maxMiniContractsForRules, normalizeRiskProfile } from './instruments';
import { createSeededRng, Rng } from './random';

interface PhaseStats {
  trades: number;
  grossWin: number;
  grossLoss: number;
  winningTrades: number;
}

interface RuntimeAccount {
  phase: SimulationPhase;
  state: AccountState;
  balance: number;
  highWaterMark: number;
  drawdownLevel: number;
  drawdownLocked: boolean;
  currentContracts: number;
  currentDay: string | null;
  dailyPnL: Record<string, number>;
  payoutCycleDailyPnL: Record<string, number>;
  payoutCycleStartBalance: number;
  tradingDays: Set<string>;
  qualifyingPayoutDays: Set<string>;
  payoutsTaken: number;
  totalPayoutAmount: number;
  blownReason: string | null;
  phaseStats: PhaseStats;
  currentConsecutiveLosses: number;
  maxConsecutiveLosses: number;
  winningPointSum: number;
  winningPointTrades: number;
  pendingTacticalTrade: TacticalPayoutTrade | null;
  lastTacticalUnlock: boolean;
  tacticalTrades: number;
  tacticalWins: number;
  tacticalPnl: number;
  payoutsUnlockedByTactical: number;
  accountsBlownByTactical: number;
}

interface ProcessResult {
  continuePhase: boolean;
  traceTrade?: TraceTrade;
}

interface TacticalPayoutTrade {
  reward: number;
  risk: number;
  winProbability: number;
}

export class SimulationEngine {
  private profile: PropFirmProfile;
  private riskProfile: RiskProfile;
  private rawTrades: RawTrade[];
  private avgTradesPerDay: number;
  private captureTrace: boolean;
  private tacticalRng: Rng;
  private currentTradeIsTactical = false;
  private traceTrades: TraceTrade[] = [];
  private globalTradeIndex = 0;

  constructor(
    profile: PropFirmProfile,
    riskProfile: RiskProfile,
    rawTrades: RawTrade[],
    avgTradesPerDay: number = 1,
    captureTrace: boolean = false,
    tacticalRng: Rng = createSeededRng('simulation-tactical-default')
  ) {
    this.profile = profile;
    this.riskProfile = normalizeRiskProfile(riskProfile);
    this.rawTrades = rawTrades;
    this.avgTradesPerDay = avgTradesPerDay;
    this.captureTrace = captureTrace;
    this.tacticalRng = tacticalRng;
  }

  public runSingleSimulation(): AccountMetrics {
    return this.run().metrics;
  }

  public run(): SimulationRunResult {
    const evalAccount = this.createAccount('evaluation');
    let tradeIndex = 0;

    while (tradeIndex < this.rawTrades.length && evalAccount.state === 'EVALUATION') {
      this.processTrade(evalAccount, this.profile.evalRules, this.rawTrades[tradeIndex]);
      tradeIndex++;
    }

    if (evalAccount.state === 'BLOWN') {
      const metrics = this.buildMetrics(evalAccount, null, null);
      return this.withTrace(metrics);
    }

    const daysToPass = evalAccount.phaseStats.trades / this.avgTradesPerDay;
    const fundedAccount = this.createAccount('funded');
    fundedAccount.state = 'FUNDED';

    while (tradeIndex < this.rawTrades.length && fundedAccount.state === 'FUNDED') {
      if (fundedAccount.pendingTacticalTrade) {
        this.processTacticalPayoutTrade(fundedAccount, this.rawTrades[tradeIndex]);
        tradeIndex++;
        continue;
      }
      this.processTrade(fundedAccount, this.profile.fundedRules, this.rawTrades[tradeIndex]);
      tradeIndex++;
    }

    const metrics = this.buildMetrics(evalAccount, fundedAccount, daysToPass);
    return this.withTrace(metrics);
  }

  private createAccount(phase: SimulationPhase): RuntimeAccount {
    const rules = phase === 'evaluation' ? this.profile.evalRules : this.profile.fundedRules;
    const initialDrawdown = this.profile.account_size - rules.drawdown.amount;
    return {
      phase,
      state: phase === 'evaluation' ? 'EVALUATION' : 'FUNDED',
      balance: this.profile.account_size,
      highWaterMark: this.profile.account_size,
      drawdownLevel: rules.drawdown.enabled ? initialDrawdown : Number.NEGATIVE_INFINITY,
      drawdownLocked: false,
      currentContracts: this.getContracts(phase, 0, this.profile.account_size),
      currentDay: null,
      dailyPnL: {},
      payoutCycleDailyPnL: {},
      payoutCycleStartBalance: this.profile.account_size,
      tradingDays: new Set<string>(),
      qualifyingPayoutDays: new Set<string>(),
      payoutsTaken: 0,
      totalPayoutAmount: 0,
      blownReason: null,
      phaseStats: {
        trades: 0,
        grossWin: 0,
        grossLoss: 0,
        winningTrades: 0
      },
      currentConsecutiveLosses: 0,
      maxConsecutiveLosses: 0
      ,
      winningPointSum: 0,
      winningPointTrades: 0,
      pendingTacticalTrade: null,
      lastTacticalUnlock: false,
      tacticalTrades: 0,
      tacticalWins: 0,
      tacticalPnl: 0,
      payoutsUnlockedByTactical: 0,
      accountsBlownByTactical: 0
    };
  }

  private processTrade(account: RuntimeAccount, rules: PhaseRules, rawTrade: RawTrade): ProcessResult {
    if (account.state === 'BLOWN' || account.state === 'PASSED' || account.state === 'GRADUATED') {
      return { continuePhase: false };
    }

    const day = rawTrade.closeTime.toISOString().split('T')[0];
    const events: TraceEvent[] = [];
    const balanceBefore = account.balance;
    const phaseRisk = getPhaseRiskConfig(this.riskProfile, account.phase, account.payoutsTaken);
    const requestedContracts = phaseRisk.contracts;
    const contracts = this.getContracts(account.phase, account.payoutsTaken, account.balance, account);
    account.currentContracts = contracts;

    const grossPnl = rawTrade.netPoints * contracts * phaseRisk.pointValue;
    const netPnl = grossPnl - (contracts * this.riskProfile.commissions);

    account.balance += netPnl;
    account.currentDay = day;
    account.phaseStats.trades++;
    account.tradingDays.add(day);
    this.globalTradeIndex++;

    account.dailyPnL[day] = (account.dailyPnL[day] || 0) + netPnl;
    account.payoutCycleDailyPnL[day] = (account.payoutCycleDailyPnL[day] || 0) + netPnl;

    if (netPnl > 0) {
      account.phaseStats.grossWin += netPnl;
      account.phaseStats.winningTrades++;
      account.winningPointSum += rawTrade.netPoints;
      account.winningPointTrades++;
      account.currentConsecutiveLosses = 0;
    } else if (netPnl < 0) {
      account.phaseStats.grossLoss += Math.abs(netPnl);
      account.currentConsecutiveLosses++;
      account.maxConsecutiveLosses = Math.max(account.maxConsecutiveLosses, account.currentConsecutiveLosses);
    }

    if (account.phase === 'funded') {
      const minProfit = this.profile.payoutRules.minProfitPerDay;
      if (minProfit === undefined || (account.payoutCycleDailyPnL[day] || 0) >= minProfit) {
        account.qualifyingPayoutDays.add(day);
      }
    }

    events.push({
      type: 'TRADE_CLOSED',
      message: `${account.phase === 'evaluation' ? 'Eval' : 'Funded'} trade closed`,
      value: netPnl
    });

    if (rules.drawdown.enabled && this.isDrawdownBreached(account)) {
      account.state = 'BLOWN';
      account.blownReason = `Hit ${rules.drawdown.mode} drawdown level ${this.money(account.drawdownLevel)}`;
      events.push({
        type: 'ACCOUNT_BLOWN',
        message: account.blownReason,
        value: account.drawdownLevel
      });
    } else {
      this.updateDrawdown(account, rules.drawdown, events);
      this.updateScaling(account, rules, events);
      if (account.phase === 'evaluation' && account.state === 'EVALUATION') {
        this.checkEvaluationRules(account, rules, events);
      } else if (account.phase === 'funded' && account.state === 'FUNDED') {
        this.checkPayoutRules(account, events);
        this.maybeScheduleTacticalPayoutTrade(account, events);
      }
    }

    const traceTrade = this.captureTrace ? this.toTraceTrade(account, rawTrade, {
      balanceBefore,
      grossPnl,
      netPnl,
      contracts,
      requestedContracts,
      instrument: phaseRisk.instrument,
      pointValue: phaseRisk.pointValue,
      day,
      events
    }) : undefined;

    if (traceTrade) {
      this.traceTrades.push(traceTrade);
    }

    return { continuePhase: account.state === 'EVALUATION' || account.state === 'FUNDED', traceTrade };
  }

  private processTacticalPayoutTrade(account: RuntimeAccount, rawTrade: RawTrade): ProcessResult {
    const tactical = account.pendingTacticalTrade;
    if (!tactical || account.state !== 'FUNDED') return { continuePhase: account.state === 'FUNDED' };

    account.pendingTacticalTrade = null;
    account.lastTacticalUnlock = false;
    const day = rawTrade.closeTime.toISOString().split('T')[0];
    const events: TraceEvent[] = [];
    const balanceBefore = account.balance;
    const won = this.tacticalRng() < tactical.winProbability;
    const netPnl = won ? tactical.reward : -tactical.risk;
    const grossPnl = netPnl;
    const phaseRisk = getPhaseRiskConfig(this.riskProfile, 'funded', account.payoutsTaken);

    account.balance += netPnl;
    account.currentDay = day;
    account.phaseStats.trades++;
    account.tradingDays.add(day);
    account.tacticalTrades++;
    account.tacticalPnl += netPnl;
    this.globalTradeIndex++;

    account.dailyPnL[day] = (account.dailyPnL[day] || 0) + netPnl;
    account.payoutCycleDailyPnL[day] = (account.payoutCycleDailyPnL[day] || 0) + netPnl;

    if (netPnl > 0) {
      account.phaseStats.grossWin += netPnl;
      account.phaseStats.winningTrades++;
      account.tacticalWins++;
      account.currentConsecutiveLosses = 0;
      events.push({
        type: 'TACTICAL_PAYOUT_TRADE_WON',
        message: `Tactical payout trade won ${this.money(tactical.reward)}`,
        value: tactical.reward
      });
    } else {
      account.phaseStats.grossLoss += Math.abs(netPnl);
      account.currentConsecutiveLosses++;
      account.maxConsecutiveLosses = Math.max(account.maxConsecutiveLosses, account.currentConsecutiveLosses);
      events.push({
        type: 'TACTICAL_PAYOUT_TRADE_LOST',
        message: `Tactical payout trade lost ${this.money(tactical.risk)}`,
        value: -tactical.risk
      });
    }

    const minProfit = this.profile.payoutRules.minProfitPerDay;
    if (minProfit === undefined || (account.payoutCycleDailyPnL[day] || 0) >= minProfit) {
      account.qualifyingPayoutDays.add(day);
    }

    if (this.profile.fundedRules.drawdown.enabled && this.isDrawdownBreached(account)) {
      account.state = 'BLOWN';
      account.blownReason = `Hit ${this.profile.fundedRules.drawdown.mode} drawdown level ${this.money(account.drawdownLevel)}`;
      account.accountsBlownByTactical++;
      events.push({
        type: 'ACCOUNT_BLOWN',
        message: account.blownReason,
        value: account.drawdownLevel
      });
    } else {
      this.updateDrawdown(account, this.profile.fundedRules.drawdown, events);
      if (account.state === 'FUNDED') {
        this.currentTradeIsTactical = true;
        this.checkPayoutRules(account, events);
        this.currentTradeIsTactical = false;
        if (account.lastTacticalUnlock) {
          events.push({
            type: 'TACTICAL_PAYOUT_UNLOCKED',
            message: 'Tactical payout trade unlocked a payout',
            value: account.totalPayoutAmount
          });
        }
      }
    }

    const traceTrade = this.captureTrace ? this.toTraceTrade(account, rawTrade, {
      balanceBefore,
      grossPnl,
      netPnl,
      contracts: 0,
      requestedContracts: 0,
      instrument: phaseRisk.instrument,
      pointValue: phaseRisk.pointValue,
      day,
      events,
      isSynthetic: true,
      syntheticType: 'TACTICAL_PAYOUT',
      winProbability: tactical.winProbability,
      rewardAmount: tactical.reward,
      riskAmount: tactical.risk,
      netPoints: 0
    }) : undefined;

    if (traceTrade) this.traceTrades.push(traceTrade);
    return { continuePhase: account.state === 'FUNDED', traceTrade };
  }

  private checkEvaluationRules(account: RuntimeAccount, rules: PhaseRules, events: TraceEvent[]) {
    const target = rules.profitTarget;
    if (!target?.enabled) return;

    if (account.balance < this.profile.account_size + target.amount) return;

    const minDays = rules.minTradingDays;
    if (minDays?.enabled && account.tradingDays.size < minDays.days) {
      events.push({
        type: 'TARGET_REACHED_WAITING_DAYS',
        message: `Target reached, waiting for ${minDays.days} trading days`,
        value: account.tradingDays.size
      });
      return;
    }

    if (this.isConsistencyBlocked(account, rules.consistency, account.dailyPnL, account.balance - this.profile.account_size)) {
      events.push({
        type: 'CONSISTENCY_BLOCKED',
        message: 'Evaluation target reached, but consistency is still above the configured limit'
      });
      return;
    }

    account.state = 'PASSED';
    events.push({
      type: 'EVAL_PASSED',
      message: 'Evaluation phase passed',
      value: account.balance
    });
  }

  private checkPayoutRules(account: RuntimeAccount, events: TraceEvent[]) {
    const payout = this.profile.payoutRules;
    if (!payout.enabled) return;

    const cycleProfit = account.balance - account.payoutCycleStartBalance;
    if (payout.positiveCycleProfitRequired && cycleProfit <= 0) return;

    if (payout.minTradingDays && account.qualifyingPayoutDays.size < payout.minTradingDays) {
      if (cycleProfit >= payout.minPayoutAmount) {
        events.push({
          type: 'PAYOUT_WAITING_DAYS',
          message: `Payout profit reached, waiting for ${payout.minTradingDays} qualifying days`,
          value: account.qualifyingPayoutDays.size
        });
      }
      return;
    }

    const balanceFloor = payout.safetyNetBalance ?? (payout.reserveAmount ? this.profile.account_size + payout.reserveAmount : undefined);
    const withdrawableAboveFloor = balanceFloor ? account.balance - balanceFloor : cycleProfit;
    if (withdrawableAboveFloor < payout.minPayoutAmount) return;

    if (this.isConsistencyBlocked(account, payout.consistency, account.payoutCycleDailyPnL, Math.max(cycleProfit, withdrawableAboveFloor))) {
      events.push({
        type: 'CONSISTENCY_BLOCKED',
        message: 'Payout is blocked by consistency rule'
      });
      return;
    }

    const payoutAmount = this.calculatePayoutAmount(account, payout, withdrawableAboveFloor, cycleProfit);
    if (payoutAmount < payout.minPayoutAmount) return;

    events.push({
      type: 'PAYOUT_ELIGIBLE',
      message: `Payout eligible for ${this.money(payoutAmount)}`,
      value: payoutAmount
    });

    const traderPayout = payoutAmount * payout.payoutSplit;
    if (payout.deductPayout) {
      account.balance -= payoutAmount;
    }
    account.payoutsTaken++;
    account.totalPayoutAmount += traderPayout;
    if (this.currentTradeIsTactical) {
      account.lastTacticalUnlock = true;
      account.payoutsUnlockedByTactical++;
    }
    events.push({
      type: 'PAYOUT_TAKEN',
      message: `Payout taken: ${this.money(traderPayout)} trader net`,
      value: traderPayout
    });

    if (payout.lockDrawdownOnPayout && account.phase === 'funded') {
      this.lockDrawdown(account, this.profile.fundedRules.drawdown, events);
    }

    if (payout.resetCycleAfterPayout) {
      account.payoutCycleStartBalance = account.balance;
      account.payoutCycleDailyPnL = {};
      account.qualifyingPayoutDays.clear();
    }

    if (payout.maxPayouts && account.payoutsTaken >= payout.maxPayouts) {
      account.state = 'GRADUATED';
    }
  }

  private calculatePayoutAmount(
    account: RuntimeAccount,
    payout: PayoutRules,
    withdrawableAboveFloor: number,
    cycleProfit: number
  ): number {
    const cap = payout.payoutCaps?.[account.payoutsTaken] ?? payout.maxPayoutAmount ?? withdrawableAboveFloor;
    const percentAmount = payout.payoutPercent ? Math.max(cycleProfit, 0) * payout.payoutPercent : cap;
    return Math.max(0, Math.min(cap, percentAmount, withdrawableAboveFloor));
  }

  private maybeScheduleTacticalPayoutTrade(account: RuntimeAccount, events: TraceEvent[]) {
    if (!this.riskProfile.useFundedTacticalPayoutTrade || account.pendingTacticalTrade || account.phase !== 'funded' || account.state !== 'FUNDED') return;
    const payout = this.profile.payoutRules;
    if (!payout.enabled || !payout.minProfitPerDay) return;
    const tactical = this.buildTacticalPayoutTrade(account);
    if (!tactical) return;
    account.pendingTacticalTrade = tactical;
    events.push({
      type: 'TACTICAL_PAYOUT_TRADE_SCHEDULED',
      message: `Tactical payout trade scheduled for next day: win ${this.money(tactical.reward)} / risk ${this.money(tactical.risk)}`,
      value: tactical.reward
    });
  }

  private buildTacticalPayoutTrade(account: RuntimeAccount): TacticalPayoutTrade | null {
    const payout = this.profile.payoutRules;
    const minProfitPerDay = payout.minProfitPerDay;
    if (!minProfitPerDay) return null;

    const currentCycleProfit = account.balance - account.payoutCycleStartBalance;
    const balanceFloor = payout.safetyNetBalance ?? (payout.reserveAmount ? this.profile.account_size + payout.reserveAmount : undefined);
    const currentWithdrawable = balanceFloor ? account.balance - balanceFloor : currentCycleProfit;
    const payoutPercent = payout.payoutPercent ?? 1;
    const payoutGap = Math.max(0, payout.minPayoutAmount - currentWithdrawable);
    const percentGap = payoutPercent > 0 ? Math.max(0, (payout.minPayoutAmount / payoutPercent) - currentCycleProfit) : 0;
    const reward = Math.max(minProfitPerDay, payoutGap, percentGap);
    if (!Number.isFinite(reward) || reward <= 0) return null;
    if (!this.wouldTacticalWinUnlockPayout(account, reward)) return null;

    const winProbability = Math.max(0, Math.min(1, Number(this.riskProfile.tacticalPayoutWinRate ?? 0.7)));
    const riskReward = Math.max(0, Number(this.riskProfile.tacticalPayoutRiskReward ?? 4));
    return {
      reward,
      risk: reward * riskReward,
      winProbability
    };
  }

  private wouldTacticalWinUnlockPayout(account: RuntimeAccount, reward: number): boolean {
    const payout = this.profile.payoutRules;
    const futureQualifyingDays = account.qualifyingPayoutDays.size + 1;
    if (payout.minTradingDays && futureQualifyingDays < payout.minTradingDays) return false;

    const futureBalance = account.balance + reward;
    const futureCycleProfit = futureBalance - account.payoutCycleStartBalance;
    if (payout.positiveCycleProfitRequired && futureCycleProfit <= 0) return false;

    const balanceFloor = payout.safetyNetBalance ?? (payout.reserveAmount ? this.profile.account_size + payout.reserveAmount : undefined);
    const withdrawableAboveFloor = balanceFloor ? futureBalance - balanceFloor : futureCycleProfit;
    if (withdrawableAboveFloor < payout.minPayoutAmount) return false;

    if (this.isConsistencyBlockedAfterTactical(account, payout, reward, Math.max(futureCycleProfit, withdrawableAboveFloor))) return false;

    const payoutAmount = this.calculateProjectedPayoutAmount(account.payoutsTaken, payout, withdrawableAboveFloor, futureCycleProfit);
    return payoutAmount >= payout.minPayoutAmount;
  }

  private calculateProjectedPayoutAmount(payoutsTaken: number, payout: PayoutRules, withdrawableAboveFloor: number, cycleProfit: number): number {
    const cap = payout.payoutCaps?.[payoutsTaken] ?? payout.maxPayoutAmount ?? withdrawableAboveFloor;
    const percentAmount = payout.payoutPercent ? Math.max(cycleProfit, 0) * payout.payoutPercent : cap;
    return Math.max(0, Math.min(cap, percentAmount, withdrawableAboveFloor));
  }

  private isConsistencyBlockedAfterTactical(account: RuntimeAccount, payout: PayoutRules, reward: number, totalProfit: number): boolean {
    if (!payout.consistency?.enabled) return false;
    return this.isConsistencyBlocked(account, payout.consistency, {
      ...account.payoutCycleDailyPnL,
      __TACTICAL_NEXT_DAY__: reward
    }, totalProfit);
  }

  private isConsistencyBlocked(
    account: RuntimeAccount,
    rule: { enabled: boolean; maxDailyProfitPercent: number } | undefined,
    dailyPnL: Record<string, number>,
    totalProfit: number
  ): boolean {
    if (!rule?.enabled || totalProfit <= 0) return false;
    const bestDay = Math.max(0, ...Object.values(dailyPnL).filter(value => value > 0));
    if (bestDay <= 0) return false;
    return (bestDay / totalProfit) > rule.maxDailyProfitPercent;
  }

  private isDrawdownBreached(account: RuntimeAccount): boolean {
    return account.balance <= account.drawdownLevel;
  }

  private updateDrawdown(account: RuntimeAccount, rule: DrawdownRule, events: TraceEvent[]) {
    if (!rule.enabled || account.drawdownLocked) return;
    if (rule.mode === 'STATIC') return;

    if (account.balance > account.highWaterMark) {
      account.highWaterMark = account.balance;
      const nextLevel = account.highWaterMark - rule.amount;
      if (nextLevel > account.drawdownLevel) {
        account.drawdownLevel = nextLevel;
        events.push({
          type: 'DRAWDOWN_UPDATED',
          message: `Drawdown level moved to ${this.money(account.drawdownLevel)}`,
          value: account.drawdownLevel
        });
      }
    }

    this.lockDrawdown(account, rule, events);
  }

  private lockDrawdown(account: RuntimeAccount, rule: DrawdownRule, events: TraceEvent[]) {
    if (!rule.lockAtBalance || account.drawdownLocked) return;
    if (account.drawdownLevel >= rule.lockAtBalance || account.balance >= rule.lockAtBalance + rule.amount) {
      account.drawdownLevel = rule.lockAtBalance;
      account.drawdownLocked = true;
      events.push({
        type: 'DRAWDOWN_UPDATED',
        message: `Drawdown locked at ${this.money(rule.lockAtBalance)}`,
        value: rule.lockAtBalance
      });
    }
  }

  private updateScaling(account: RuntimeAccount, rules: PhaseRules, events: TraceEvent[]) {
    if (!rules.scaling?.enabled) return;
    const nextContracts = this.getContracts(account.phase, account.payoutsTaken, account.balance);
    if (nextContracts !== account.currentContracts) {
      account.currentContracts = nextContracts;
      events.push({
        type: 'SCALING_CHANGED',
        message: `Contract limit changed to ${nextContracts}`,
        value: nextContracts
      });
    }
  }

  private getContracts(phase: SimulationPhase, payoutsTaken: number, balance: number, account?: RuntimeAccount): number {
    const phaseRules = phase === 'evaluation' ? this.profile.evalRules : this.profile.fundedRules;
    const phaseRisk = getPhaseRiskConfig(this.riskProfile, phase, payoutsTaken);
    const desired = phaseRisk.contracts;

    const scalingLimit = this.getScalingLimit(phaseRules, balance);
    const maxContracts = contractLimitForRules(phaseRules, phaseRisk.instrument, scalingLimit);
    const capped = Math.max(0, Math.min(desired, maxContracts));
    if (phase !== 'evaluation' || !this.riskProfile.useSmartScaling || !phaseRules.profitTarget?.enabled || !account) {
      return capped;
    }

    const remainingProfit = this.profile.account_size + phaseRules.profitTarget.amount - balance;
    if (remainingProfit <= 0) return capped;
    const avgWinPoints = account.winningPointTrades > 0 ? account.winningPointSum / account.winningPointTrades : 7.5;
    const expectedNetPerContract = (avgWinPoints * phaseRisk.pointValue) - this.riskProfile.commissions;
    if (expectedNetPerContract <= 0) return capped;
    return Math.max(1, Math.min(capped, Math.ceil(remainingProfit / expectedNetPerContract)));
  }

  private getScalingLimit(rules: PhaseRules, balance: number): number | null {
    if (!rules.scaling?.enabled || rules.scaling.tiers.length === 0) return null;
    const profit = balance - this.profile.account_size;
    const tiers = [...rules.scaling.tiers].sort((a, b) => a.profitFrom - b.profitFrom);
    let selected = tiers[0].contracts;
    for (const tier of tiers) {
      if (profit >= tier.profitFrom) selected = tier.contracts;
    }
    return Math.min(selected, maxMiniContractsForRules(rules));
  }

  private buildMetrics(evalAccount: RuntimeAccount, fundedAccount: RuntimeAccount | null, daysToPass: number | null): AccountMetrics {
    const evalStats = evalAccount.phaseStats;
    const fundedStats = fundedAccount?.phaseStats || { trades: 0, grossWin: 0, grossLoss: 0, winningTrades: 0 };
    const totalTrades = evalStats.trades + fundedStats.trades;
    const grossWin = evalStats.grossWin + fundedStats.grossWin;
    const grossLoss = evalStats.grossLoss + fundedStats.grossLoss;
    const winningTrades = evalStats.winningTrades + fundedStats.winningTrades;
    const finalAccount = fundedAccount || evalAccount;

    return {
      accountId: 'SIM-1',
      firmName: this.profile.firm_name,
      status: finalAccount.state,
      finalBalance: finalAccount.balance,
      totalTrades,
      daysToPass,
      payoutsTaken: fundedAccount?.payoutsTaken || 0,
      totalPayoutAmount: fundedAccount?.totalPayoutAmount || 0,
      blownReason: finalAccount.blownReason,
      fundedLifespanDays: fundedAccount ? fundedStats.trades / this.avgTradesPerDay : null,
      maxConsecutiveLosses: Math.max(evalAccount.maxConsecutiveLosses, fundedAccount?.maxConsecutiveLosses || 0),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      grossWin,
      grossLoss,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      averageNetPerTrade: totalTrades > 0 ? (grossWin - grossLoss) / totalTrades : 0,
      evalTrades: evalStats.trades,
      fundedTrades: fundedStats.trades,
      evalGrossWin: evalStats.grossWin,
      evalGrossLoss: evalStats.grossLoss,
      evalWinningTrades: evalStats.winningTrades,
      fundedGrossWin: fundedStats.grossWin,
      fundedGrossLoss: fundedStats.grossLoss,
      fundedWinningTrades: fundedStats.winningTrades,
      tacticalTrades: fundedAccount?.tacticalTrades || 0,
      tacticalWins: fundedAccount?.tacticalWins || 0,
      tacticalPnl: fundedAccount?.tacticalPnl || 0,
      payoutsUnlockedByTactical: fundedAccount?.payoutsUnlockedByTactical || 0,
      accountsBlownByTactical: fundedAccount?.accountsBlownByTactical || 0
    };
  }

  private withTrace(metrics: AccountMetrics): SimulationRunResult {
    if (!this.captureTrace) return { metrics };
    const trace: SimulationTrace = {
      id: 'trace',
      label: 'Trace',
      status: metrics.status,
      summary: {
        finalBalance: metrics.finalBalance,
        totalTrades: metrics.totalTrades,
        evalTrades: metrics.evalTrades,
        fundedTrades: metrics.fundedTrades,
        payoutsTaken: metrics.payoutsTaken,
        totalPayoutAmount: metrics.totalPayoutAmount,
        blownReason: metrics.blownReason
      },
      trades: this.traceTrades
    };
    return { metrics, trace };
  }

  private toTraceTrade(
    account: RuntimeAccount,
    rawTrade: RawTrade,
    data: {
      balanceBefore: number;
      grossPnl: number;
      netPnl: number;
      contracts: number;
      requestedContracts: number;
      instrument: TraceTrade['instrument'];
      pointValue: number;
      day: string;
      events: TraceEvent[];
      isSynthetic?: boolean;
      syntheticType?: TraceTrade['syntheticType'];
      winProbability?: number;
      rewardAmount?: number;
      riskAmount?: number;
      netPoints?: number;
    }
  ): TraceTrade {
    return {
      index: this.globalTradeIndex,
      phase: account.phase,
      ticket: rawTrade.ticket,
      symbol: rawTrade.symbol,
      instrument: data.instrument,
      closeTime: rawTrade.closeTime.toISOString(),
      netPoints: data.netPoints ?? rawTrade.netPoints,
      contracts: data.contracts,
      requestedContracts: data.requestedContracts,
      executedContracts: data.contracts,
      pointValue: data.pointValue,
      grossPnl: data.grossPnl,
      netPnl: data.netPnl,
      balanceBefore: data.balanceBefore,
      balanceAfter: account.balance,
      highWaterMark: account.highWaterMark,
      drawdownLevel: account.drawdownLevel,
      cycleProfit: account.balance - account.payoutCycleStartBalance,
      events: data.events,
      isSynthetic: data.isSynthetic,
      syntheticType: data.syntheticType,
      winProbability: data.winProbability,
      rewardAmount: data.rewardAmount,
      riskAmount: data.riskAmount
    };
  }

  private money(value: number): string {
    return `$${value.toFixed(2)}`;
  }
}
