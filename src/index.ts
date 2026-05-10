import path from 'path';
import { TradeParser } from './tradeParser';
import { MonteCarloEngine } from './monteCarloEngine';
import { ProfileStore } from './profileStore';
import { RiskProfile } from './types';

async function main() {
  const configDir = path.join(__dirname, '../config/prop_firms');
  const strategyPath = path.join(__dirname, '../strategies/lot-2/Strategy 1.1.735.csv');
  const profileStore = new ProfileStore(configDir);
  const trades = await TradeParser.parseSqxCsv(strategyPath);

  const riskProfile: RiskProfile = {
    evaluationContracts: 2,
    fundedPrePayoutContracts: 2,
    fundedPostPayoutContracts: 1,
    pointValue: 20,
    commissions: 4,
    useSmartScaling: true
  };

  for (const profile of profileStore.list()) {
    const engine = new MonteCarloEngine(profile, riskProfile, trades, 1000, {
      mode: 'seeded',
      seed: `cli-${profile.id}`
    });
    const metrics = engine.run();
    console.log(`${profile.firm_name}: pass ${metrics.passRatePercent.toFixed(1)}%, payout ${metrics.payoutRatePercent.toFixed(1)}%, EV $${metrics.expectedValue.toFixed(2)}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
