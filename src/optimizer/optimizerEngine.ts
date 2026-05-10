import { MonteCarloEngine } from '../monteCarloEngine';
import { generateCandidates } from './candidateGenerator';
import { badgesFor, scoreRiskAdjustedEV } from './scoring';
import { OptimizerEngineInput, OptimizerResponse, OptimizerResultRow } from './types';

export class OptimizerEngine {
  constructor(private input: OptimizerEngineInput) {}

  run(): OptimizerResponse {
    const iterations = Math.max(100, Number(this.input.request.iterations ?? 1000));
    const candidates = generateCandidates(this.input.profile, this.input.request);
    const rows: OptimizerResultRow[] = [];

    for (const strategyInput of this.input.strategies) {
      for (const candidate of candidates) {
        const engine = new MonteCarloEngine(
          this.input.profile,
          candidate.riskProfile,
          strategyInput.trades,
          iterations,
          {
            mode: this.input.request.randomization?.mode ?? 'seeded',
            seed: `${this.input.request.randomization?.seed ?? 'optimizer'}:${strategyInput.strategy}:${candidate.id}`
          }
        );
        const metrics = engine.run();
        rows.push({
          strategy: strategyInput.strategy,
          candidate,
          metrics,
          score: scoreRiskAdjustedEV(metrics),
          badges: []
        });
      }
    }

    const sorted = rows.sort((a, b) => b.score - a.score);
    const bestScore = sorted[0]?.score ?? 0;
    const fastestDays = Math.min(...sorted.filter(row => row.metrics.passRatePercent > 0).map(row => row.metrics.avgDaysToPass));
    const bestStability = Math.min(...sorted.map(row => row.metrics.medianMaxConsecutiveLosses));
    for (const row of sorted) {
      row.badges = badgesFor(row.metrics, row.score, bestScore, fastestDays, bestStability);
    }

    return {
      iterations,
      objective: 'riskAdjustedEV',
      results: sorted.slice(0, 100),
      candidateCount: candidates.length
    };
  }
}
