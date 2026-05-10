import { Instrument, PhaseRiskConfig, PhaseRules, RiskProfile, SimulationPhase } from './types';

export const INSTRUMENT_POINT_VALUES: Record<Instrument, number> = {
  NQ: 20,
  MNQ: 2,
  ES: 50,
  MES: 5
};

export function pointValueForInstrument(instrument: Instrument): number {
  return INSTRUMENT_POINT_VALUES[instrument] ?? 20;
}

export function contractLimitForInstrument(maxMiniContracts: number, instrument: Instrument, maxMicroContracts?: number): number {
  if (isMicroInstrument(instrument)) {
    return Math.max(0, Math.floor(maxMicroContracts ?? maxMiniContracts * microMultiplierForInstrument(instrument)));
  }
  return Math.max(0, Math.floor(maxMiniContracts));
}

export function contractLimitForRules(rules: PhaseRules, instrument: Instrument, scalingMiniLimit?: number | null): number {
  const miniLimit = scalingMiniLimit ?? maxMiniContractsForRules(rules);
  const microLimit = isMicroInstrument(instrument) && scalingMiniLimit !== undefined && scalingMiniLimit !== null
    ? Math.min(maxMicroContractsForRules(rules), Math.floor(miniLimit * microMultiplierForInstrument(instrument)))
    : isMicroInstrument(instrument)
      ? maxMicroContractsForRules(rules)
      : undefined;
  return contractLimitForInstrument(miniLimit, instrument, microLimit);
}

export function maxMiniContractsForRules(rules: PhaseRules): number {
  return Number(rules.maxMiniContracts ?? rules.maxContracts);
}

export function maxMicroContractsForRules(rules: PhaseRules): number {
  return Number(rules.maxMicroContracts ?? maxMiniContractsForRules(rules) * 10);
}

export function isMicroInstrument(instrument: Instrument): boolean {
  return instrument === 'MNQ' || instrument === 'MES';
}

export function microMultiplierForInstrument(instrument: Instrument): number {
  return instrument === 'MNQ' || instrument === 'MES' ? 10 : 1;
}

export function normalizeInstrument(value: unknown, fallback: Instrument = 'NQ'): Instrument {
  return value === 'NQ' || value === 'MNQ' || value === 'ES' || value === 'MES' ? value : fallback;
}

export function buildPhaseRiskConfig(
  input: Partial<PhaseRiskConfig> | undefined,
  contracts: number,
  instrument: Instrument
): PhaseRiskConfig {
  const normalizedInstrument = normalizeInstrument(input?.instrument, instrument);
  return {
    instrument: normalizedInstrument,
    contracts: Number(input?.contracts ?? contracts),
    pointValue: Number(input?.pointValue ?? pointValueForInstrument(normalizedInstrument))
  };
}

export function normalizeRiskProfile(profile: RiskProfile): RiskProfile {
  const legacyInstrument = instrumentFromPointValue(profile.pointValue ?? 20);
  const legacyPointValue = profile.pointValue ?? pointValueForInstrument(legacyInstrument);
  const evaluation = profile.evaluation
    ? buildPhaseRiskConfig(profile.evaluation, profile.evaluationContracts ?? 2, legacyInstrument)
    : { instrument: legacyInstrument, contracts: profile.evaluationContracts ?? 2, pointValue: legacyPointValue };
  const fundedPrePayout = profile.fundedPrePayout
    ? buildPhaseRiskConfig(profile.fundedPrePayout, profile.fundedPrePayoutContracts ?? 2, legacyInstrument)
    : { instrument: legacyInstrument, contracts: profile.fundedPrePayoutContracts ?? 2, pointValue: legacyPointValue };
  const fundedPostPayout = profile.fundedPostPayout
    ? buildPhaseRiskConfig(profile.fundedPostPayout, profile.fundedPostPayoutContracts ?? 1, legacyInstrument)
    : { instrument: legacyInstrument, contracts: profile.fundedPostPayoutContracts ?? 1, pointValue: legacyPointValue };

  return {
    ...profile,
    evaluation,
    fundedPrePayout,
    fundedPostPayout,
    evaluationContracts: profile.evaluation?.contracts ?? profile.evaluationContracts ?? 2,
    fundedPrePayoutContracts: profile.fundedPrePayout?.contracts ?? profile.fundedPrePayoutContracts ?? 2,
    fundedPostPayoutContracts: profile.fundedPostPayout?.contracts ?? profile.fundedPostPayoutContracts ?? 1,
    pointValue: legacyPointValue
  };
}

export function getPhaseRiskConfig(profile: RiskProfile, phase: SimulationPhase, payoutsTaken: number): PhaseRiskConfig {
  const normalized = normalizeRiskProfile(profile);
  if (phase === 'evaluation') return normalized.evaluation!;
  return payoutsTaken === 0 ? normalized.fundedPrePayout! : normalized.fundedPostPayout!;
}

function instrumentFromPointValue(pointValue: number): Instrument {
  if (pointValue === 2) return 'MNQ';
  if (pointValue === 50) return 'ES';
  if (pointValue === 5) return 'MES';
  return 'NQ';
}
