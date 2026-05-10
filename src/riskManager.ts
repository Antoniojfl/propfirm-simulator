import { AccountState, RiskProfile } from './types';
import { normalizeRiskProfile } from './instruments';

export class RiskManager {
  private profile: RiskProfile;

  constructor(profile: RiskProfile) {
    this.profile = normalizeRiskProfile(profile);
  }

  getContractsForState(state: AccountState, payoutsTaken: number): number {
    switch (state) {
      case 'EVALUATION':
        return this.profile.evaluationContracts ?? this.profile.evaluation?.contracts ?? 0;
      case 'FUNDED':
        if (payoutsTaken === 0) {
          return this.profile.fundedPrePayoutContracts ?? this.profile.fundedPrePayout?.contracts ?? 0;
        } else {
          return this.profile.fundedPostPayoutContracts ?? this.profile.fundedPostPayout?.contracts ?? 0;
        }
      case 'BLOWN':
      case 'PASSED':
        return 0;
      default:
        return 0;
    }
  }

  getPointValue(): number {
    return this.profile.pointValue ?? this.profile.evaluation?.pointValue ?? 20;
  }

  getCommissions(): number {
    return this.profile.commissions;
  }

  isSmartScalingEnabled(): boolean {
    return this.profile.useSmartScaling;
  }
}
