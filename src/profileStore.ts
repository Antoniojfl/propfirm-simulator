import fs from 'fs';
import path from 'path';
import { PropFirmProfile } from './types';

export interface StoredProfile extends PropFirmProfile {
  id: string;
}

export class ProfileValidationError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('; '));
  }
}

export class ProfileStore {
  constructor(private configDir: string) {}

  list(): StoredProfile[] {
    this.ensureDirs();
    return fs.readdirSync(this.configDir)
      .filter(file => file.endsWith('.json'))
      .map(file => this.read(file));
  }

  read(id: string): StoredProfile {
    this.assertSafeId(id);
    const filePath = path.join(this.configDir, id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Profile ${id} not found`);
    }
    const profile = this.normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')) as PropFirmProfile);
    return { ...profile, id };
  }

  save(id: string, profile: PropFirmProfile): StoredProfile {
    this.assertSafeId(id);
    const normalized = this.normalize(profile);
    this.validate(normalized);
    fs.writeFileSync(path.join(this.configDir, id), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return { ...normalized, id };
  }

  duplicate(id: string): StoredProfile {
    const source = this.read(id);
    const baseSlug = this.slugify(`${source.firm_name}-copy`);
    let nextId = `${baseSlug}.json`;
    let index = 2;
    while (fs.existsSync(path.join(this.configDir, nextId))) {
      nextId = `${baseSlug}-${index}.json`;
      index++;
    }
    const copy: PropFirmProfile = {
      ...source,
      id: undefined,
      firm_name: `${source.firm_name} Copy`,
      display_name: `${source.display_name || source.firm_name} Copy`,
      official: false,
      version: source.version + 1
    };
    return this.save(nextId, copy);
  }

  restore(id: string): StoredProfile {
    this.assertSafeId(id);
    const defaultsDir = path.join(this.configDir, 'defaults');
    const defaultPath = path.join(defaultsDir, id);
    if (!fs.existsSync(defaultPath)) {
      throw new Error(`No official default exists for ${id}`);
    }
    fs.copyFileSync(defaultPath, path.join(this.configDir, id));
    return this.read(id);
  }

  validate(profile: PropFirmProfile): void {
    const errors: string[] = [];
    const positive = (label: string, value: number | undefined, allowZero = false) => {
      if (value === undefined || Number.isNaN(value) || (allowZero ? value < 0 : value <= 0)) {
        errors.push(`${label} must be ${allowZero ? 'zero or positive' : 'positive'}`);
      }
    };

    if (!profile.firm_name?.trim()) errors.push('firm_name is required');
    positive('account_size', profile.account_size);
    positive('cost', profile.cost, true);

    for (const [phase, rules] of Object.entries({ evalRules: profile.evalRules, fundedRules: profile.fundedRules })) {
      if (!rules) {
        errors.push(`${phase} is required`);
        continue;
      }
      const maxMiniContracts = rules.maxMiniContracts ?? rules.maxContracts;
      const maxMicroContracts = rules.maxMicroContracts ?? maxMiniContracts * 10;
      positive(`${phase}.maxContracts`, rules.maxContracts);
      positive(`${phase}.maxMiniContracts`, maxMiniContracts);
      positive(`${phase}.maxMicroContracts`, maxMicroContracts);
      if (maxMicroContracts < maxMiniContracts) {
        errors.push(`${phase}.maxMicroContracts should be greater than or equal to maxMiniContracts`);
      }
      positive(`${phase}.drawdown.amount`, rules.drawdown?.amount);
      if (!['EOD', 'INTRADAY', 'STATIC'].includes(rules.drawdown?.mode)) {
        errors.push(`${phase}.drawdown.mode is invalid`);
      }
      if (rules.profitTarget?.enabled) positive(`${phase}.profitTarget.amount`, rules.profitTarget.amount);
      if (rules.consistency?.enabled) this.validatePercent(`${phase}.consistency.maxDailyProfitPercent`, rules.consistency.maxDailyProfitPercent, errors);
      if (rules.minTradingDays?.enabled) positive(`${phase}.minTradingDays.days`, rules.minTradingDays.days);
      if (rules.scaling?.enabled) {
        if (!rules.scaling.tiers?.length) errors.push(`${phase}.scaling.tiers is required when scaling is enabled`);
        for (const tier of rules.scaling.tiers || []) {
          positive(`${phase}.scaling.tier.contracts`, tier.contracts);
          positive(`${phase}.scaling.tier.profitFrom`, tier.profitFrom, true);
        }
      }
    }

    const payout = profile.payoutRules;
    if (!payout) {
      errors.push('payoutRules is required');
    } else {
      positive('payoutRules.minPayoutAmount', payout.minPayoutAmount);
      if (payout.maxPayoutAmount !== undefined) positive('payoutRules.maxPayoutAmount', payout.maxPayoutAmount);
      if (payout.maxPayoutAmount !== undefined && payout.maxPayoutAmount < payout.minPayoutAmount) {
        errors.push('payoutRules.maxPayoutAmount must be greater than or equal to minPayoutAmount');
      }
      if (payout.payoutCaps) {
        payout.payoutCaps.forEach((cap, index) => positive(`payoutRules.payoutCaps[${index}]`, cap));
      }
      if (payout.payoutPercent !== undefined) this.validatePercent('payoutRules.payoutPercent', payout.payoutPercent, errors);
      this.validatePercent('payoutRules.payoutSplit', payout.payoutSplit, errors);
      if (payout.consistency?.enabled) this.validatePercent('payoutRules.consistency.maxDailyProfitPercent', payout.consistency.maxDailyProfitPercent, errors);
    }

    if (errors.length) throw new ProfileValidationError(errors);
  }

  private validatePercent(label: string, value: number | undefined, errors: string[]) {
    if (value === undefined || Number.isNaN(value) || value < 0 || value > 1) {
      errors.push(`${label} must be between 0 and 1`);
    }
  }

  private normalize(profile: PropFirmProfile): PropFirmProfile {
    const { id: _id, ...rest } = profile as PropFirmProfile & { id?: string };
    return {
      ...rest,
      evalRules: this.normalizePhaseRules(rest.evalRules),
      fundedRules: this.normalizePhaseRules(rest.fundedRules),
      version: Number(rest.version || 1),
      official: Boolean(rest.official)
    };
  }

  private normalizePhaseRules(rules: PropFirmProfile['evalRules']): PropFirmProfile['evalRules'] {
    const maxMiniContracts = Number(rules.maxMiniContracts ?? rules.maxContracts);
    const maxMicroContracts = Number(rules.maxMicroContracts ?? maxMiniContracts * 10);
    return {
      ...rules,
      maxContracts: Number(rules.maxContracts ?? maxMiniContracts),
      maxMiniContracts,
      maxMicroContracts
    };
  }

  private ensureDirs() {
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir, { recursive: true });
    const defaults = path.join(this.configDir, 'defaults');
    if (!fs.existsSync(defaults)) fs.mkdirSync(defaults, { recursive: true });
    for (const file of fs.readdirSync(this.configDir).filter(item => item.endsWith('.json'))) {
      const sourcePath = path.join(this.configDir, file);
      const defaultPath = path.join(defaults, file);
      if (fs.existsSync(defaultPath)) continue;
      try {
        const profile = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as PropFirmProfile;
        if (profile.official) fs.copyFileSync(sourcePath, defaultPath);
      } catch {
        // Invalid profiles are handled by normal reads; defaults are best effort.
      }
    }
  }

  private assertSafeId(id: string) {
    if (!/^[a-zA-Z0-9_.-]+\.json$/.test(id)) {
      throw new Error('Invalid profile id');
    }
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  }
}
