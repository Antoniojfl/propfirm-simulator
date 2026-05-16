import { contractLimitForRules, maxMiniContractsForRules, pointValueForInstrument } from '../instruments';
import { Instrument, PropFirmProfile, RiskProfile } from '../types';
import { OptimizerCandidate, OptimizerPhaseSearch, OptimizerRequest } from './types';

const DEFAULT_INSTRUMENTS: Instrument[] = ['NQ', 'MNQ'];

export function generateCandidates(profile: PropFirmProfile, request: OptimizerRequest): OptimizerCandidate[] {
  const evalSearch = normalizePhaseSearch(request.evaluation, maxMiniContractsForRules(profile.evalRules));
  const preSearch = normalizePhaseSearch(request.fundedPrePayout, maxMiniContractsForRules(profile.fundedRules));
  const postSearch = normalizePhaseSearch(request.fundedPostPayout, maxMiniContractsForRules(profile.fundedRules));
  const smartScalingOptions = request.useSmartScaling === 'both'
    ? [true, false]
    : [request.useSmartScaling !== undefined ? Boolean(request.useSmartScaling) : true];

  const candidates: OptimizerCandidate[] = [];

  for (const evalInstrument of evalSearch.instruments) {
    const evalMax = contractLimitForRules(profile.evalRules, evalInstrument);
    for (const evalContracts of range(evalSearch.contracts.min, Math.min(evalSearch.contracts.max, evalMax))) {
      for (const preInstrument of preSearch.instruments) {
        const preMax = contractLimitForRules(profile.fundedRules, preInstrument);
        for (const preContracts of range(preSearch.contracts.min, Math.min(preSearch.contracts.max, preMax))) {
          for (const postInstrument of postSearch.instruments) {
            const postMax = contractLimitForRules(profile.fundedRules, postInstrument);
            for (const postContracts of range(postSearch.contracts.min, Math.min(postSearch.contracts.max, postMax))) {
              for (const useSmartScaling of smartScalingOptions) {
                const riskProfile = buildRiskProfile({
                  evalInstrument,
                  evalContracts,
                  preInstrument,
                  preContracts,
                  postInstrument,
                  postContracts,
                  commissions: request.commissions ?? 4,
                  useSmartScaling,
                  useFundedTacticalPayoutTrade: Boolean(request.useFundedTacticalPayoutTrade),
                  tacticalPayoutWinRate: request.tacticalPayoutWinRate ?? 0.7,
                  tacticalPayoutRiskReward: request.tacticalPayoutRiskReward ?? 4
                });
                candidates.push({
                  id: [
                    evalInstrument, evalContracts,
                    preInstrument, preContracts,
                    postInstrument, postContracts,
                    useSmartScaling ? 'smart' : 'raw'
                  ].join('-'),
                  label: `Eval ${evalInstrument} x${evalContracts} / Pre ${preInstrument} x${preContracts} / Post ${postInstrument} x${postContracts}${useSmartScaling ? ' / Smart' : ''}`,
                  riskProfile
                });
              }
            }
          }
        }
      }
    }
  }

  return candidates.slice(0, request.maxCandidates ?? 250);
}

function normalizePhaseSearch(search: OptimizerPhaseSearch | undefined, maxContracts: number): OptimizerPhaseSearch {
  return {
    instruments: search?.instruments?.length ? search.instruments : DEFAULT_INSTRUMENTS,
    contracts: {
      min: Math.max(1, Number(search?.contracts?.min ?? 1)),
      max: Math.max(1, Number(search?.contracts?.max ?? maxContracts))
    }
  };
}

function range(min: number, max: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value++) values.push(value);
  return values;
}

function buildRiskProfile(input: {
  evalInstrument: Instrument;
  evalContracts: number;
  preInstrument: Instrument;
  preContracts: number;
  postInstrument: Instrument;
  postContracts: number;
  commissions: number;
  useSmartScaling: boolean;
  useFundedTacticalPayoutTrade: boolean;
  tacticalPayoutWinRate: number;
  tacticalPayoutRiskReward: number;
}): RiskProfile {
  return {
    evaluationContracts: input.evalContracts,
    fundedPrePayoutContracts: input.preContracts,
    fundedPostPayoutContracts: input.postContracts,
    pointValue: pointValueForInstrument(input.evalInstrument),
    evaluation: {
      instrument: input.evalInstrument,
      contracts: input.evalContracts,
      pointValue: pointValueForInstrument(input.evalInstrument)
    },
    fundedPrePayout: {
      instrument: input.preInstrument,
      contracts: input.preContracts,
      pointValue: pointValueForInstrument(input.preInstrument)
    },
    fundedPostPayout: {
      instrument: input.postInstrument,
      contracts: input.postContracts,
      pointValue: pointValueForInstrument(input.postInstrument)
    },
    commissions: input.commissions,
    useSmartScaling: input.useSmartScaling,
    useFundedTacticalPayoutTrade: input.useFundedTacticalPayoutTrade,
    tacticalPayoutWinRate: input.tacticalPayoutWinRate,
    tacticalPayoutRiskReward: input.tacticalPayoutRiskReward
  };
}
