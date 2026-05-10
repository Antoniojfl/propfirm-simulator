import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { TradeParser } from './tradeParser';
import { MonteCarloEngine } from './monteCarloEngine';
import { PropFirmProfile, RandomizationConfig, RiskProfile } from './types';
import { ProfileStore, ProfileValidationError } from './profileStore';
import { createRunSeed } from './random';
import { normalizeInstrument, pointValueForInstrument } from './instruments';
import { generateCandidates } from './optimizer/candidateGenerator';
import { badgesFor, scoreRiskAdjustedEV } from './optimizer/scoring';
import { OptimizerRequest, OptimizerResultRow } from './optimizer/types';
import { BankrollEngine } from './bankroll/bankrollEngine';
import { BankrollRequest } from './bankroll/types';

interface SimulationSession {
  id: string;
  profileId: string;
  folder: string;
  riskProfile: RiskProfile;
  randomization: RandomizationConfig;
  effectiveSeed: string;
  createdAt: number;
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const configDir = path.join(__dirname, '../config/prop_firms');
const strategiesDir = path.join(__dirname, '../strategies');
const profileStore = new ProfileStore(configDir);
const sessions = new Map<string, SimulationSession>();
const jobs = new Map<string, JobRecord>();

type JobType = 'simulation' | 'optimizer' | 'bankroll';
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface JobProgress {
  current: number;
  total: number;
  percent: number;
  message: string;
}

interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: JobProgress;
  result?: unknown;
  error?: string;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

class CancelledJobError extends Error {
  constructor() {
    super('Run cancelled');
  }
}

app.get('/api/profiles', (_req, res) => {
  try {
    const profiles = profileStore.list().map(profile => ({
      id: profile.id,
      name: profile.display_name || profile.firm_name,
      type: profile.evalRules.drawdown.mode,
      profile
    }));
    res.json(profiles);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load profiles' });
  }
});

app.get('/api/profiles/:id', (req, res) => {
  try {
    res.json(profileStore.read(req.params.id));
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

app.put('/api/profiles/:id', (req, res) => {
  try {
    const saved = profileStore.save(req.params.id, req.body as PropFirmProfile);
    res.json(saved);
  } catch (error: any) {
    if (error instanceof ProfileValidationError) {
      return res.status(400).json({ error: 'Profile validation failed', details: error.errors });
    }
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/profiles/:id/duplicate', (req, res) => {
  try {
    res.json(profileStore.duplicate(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/profiles/:id/restore', (req, res) => {
  try {
    res.json(profileStore.restore(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/profiles/validate', (req, res) => {
  try {
    profileStore.validate(req.body as PropFirmProfile);
    res.json({ ok: true });
  } catch (error: any) {
    if (error instanceof ProfileValidationError) {
      return res.status(400).json({ ok: false, details: error.errors });
    }
    res.status(400).json({ ok: false, details: [error.message] });
  }
});

app.get('/api/folders', (_req, res) => {
  try {
    const folders = fs.readdirSync(strategiesDir, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(dir => dir.name)
      .filter(folderName => {
        const folderPath = path.join(strategiesDir, folderName);
        return fs.readdirSync(folderPath).some(file => file.endsWith('.csv'));
      });

    if (fs.readdirSync(strategiesDir, { withFileTypes: true }).some(file => file.isFile() && file.name.endsWith('.csv'))) {
      folders.unshift('/');
    }

    res.json(folders);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load folders' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(serializeJob(job));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return res.json(serializeJob(job));
  }
  job.cancelRequested = true;
  updateJobProgress(job, job.progress.current, job.progress.total, 'Cancelando al terminar la unidad actual...');
  res.json(serializeJob(job));
});

app.post('/api/simulate', async (req, res) => {
  const { profileId, folder, riskConfig, randomization } = req.body;
  if (!profileId || !folder) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const job = createJob('simulation');
  res.status(202).json({ jobId: job.id });
  void runSimulationJob(job, { profileId, folder, riskConfig, randomization });
});

app.post('/api/optimize', async (req, res) => {
  const body = req.body as OptimizerRequest & { profileId?: string; folder?: string; strategy?: string };
  if (!body.profileId || !body.folder) {
    return res.status(400).json({ error: 'Invalid optimizer payload' });
  }

  const job = createJob('optimizer');
  res.status(202).json({ jobId: job.id });
  void runOptimizerJob(job, body);
});

app.post('/api/bankroll/simulate', async (req, res) => {
  const body = req.body as BankrollRequest;
  if (!body.profileId || !body.folder || !body.strategies?.length) {
    return res.status(400).json({ error: 'Invalid bankroll payload' });
  }

  const job = createJob('bankroll');
  res.status(202).json({ jobId: job.id });
  void runBankrollJob(job, body);
});

app.get('/api/simulations/:id/strategies/:strategy/traces', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Simulation session not found' });

  try {
    const profile = profileStore.read(session.profileId);
    const targetDir = resolveStrategyFolder(session.folder);
    const strategy = decodeURIComponent(req.params.strategy);
    const safeStrategy = path.basename(strategy);
    const csvPath = path.join(targetDir, safeStrategy);
    if (!fs.existsSync(csvPath) || !safeStrategy.endsWith('.csv')) {
      return res.status(404).json({ error: 'Strategy file not found' });
    }

    const trades = await TradeParser.parseSqxCsv(csvPath);
    const strategySeed = `${session.effectiveSeed}:${safeStrategy}`;
    const engine = new MonteCarloEngine(profile, session.riskProfile, trades, 5, {
      ...session.randomization,
      seed: strategySeed
    });
    res.json({
      simulationId: session.id,
      strategy: safeStrategy,
      traces: engine.buildTraces(5)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

async function runSimulationJob(job: JobRecord, input: {
  profileId: string;
  folder: string;
  riskConfig: any;
  randomization: any;
}) {
  try {
    markJobRunning(job, 'Preparando simulacion...');
    const profile = profileStore.read(input.profileId);
    const riskProfile = buildRiskProfile(input.riskConfig);
    const randomizationConfig = buildRandomization(input.randomization);
    const sessionId = `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const effectiveSeed = createRunSeed(randomizationConfig.seed);
    const targetDir = resolveStrategyFolder(input.folder);
    const files = fs.readdirSync(targetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No strategies found in the selected folder');
    }

    const results: Array<{ strategy: string; metrics: ReturnType<MonteCarloEngine['run']> }> = [];
    updateJobProgress(job, 0, files.length, `0/${files.length} estrategias`);

    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      updateJobProgress(job, index, files.length, `Leyendo ${strategyFile}`);
      const trades = await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile));
      const strategySeed = `${effectiveSeed}:${strategyFile}`;
      const engine = new MonteCarloEngine(profile, riskProfile, trades, 1000, {
        ...randomizationConfig,
        seed: strategySeed
      });
      const metrics = engine.run();
      results.push({ strategy: strategyFile, metrics });
      updateJobProgress(job, index + 1, files.length, `${index + 1}/${files.length} estrategias`);
      await yieldToEventLoop();
    }

    sessions.set(sessionId, {
      id: sessionId,
      profileId: input.profileId,
      folder: input.folder,
      riskProfile,
      randomization: randomizationConfig,
      effectiveSeed,
      createdAt: Date.now()
    });

    completeJob(job, {
      simulationId: sessionId,
      randomization: {
        mode: randomizationConfig.mode,
        seed: effectiveSeed
      },
      results
    });
  } catch (error: any) {
    failJob(job, error);
  }
}

async function runOptimizerJob(job: JobRecord, body: OptimizerRequest & { profileId?: string; folder?: string; strategy?: string }) {
  try {
    markJobRunning(job, 'Preparando optimizer...');
    const profile = profileStore.read(body.profileId!);
    const targetDir = resolveStrategyFolder(body.folder!);
    const files = body.strategy
      ? [path.basename(body.strategy)]
      : fs.readdirSync(targetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No strategies found in the selected folder');
    }

    updateJobProgress(job, 0, files.length, 'Leyendo estrategias...');
    const strategies = [];
    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      strategies.push({
        strategy: strategyFile,
        trades: await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile))
      });
      updateJobProgress(job, index + 1, files.length, `Leyendo ${index + 1}/${files.length}`);
      await yieldToEventLoop();
    }

    const candidates = generateCandidates(profile, body);
    const iterations = Number(body.iterations ?? 1000);
    const randomization = body.randomization ?? { mode: 'seeded' as const, seed: 'optimizer-v1' };
    const totalRuns = Math.max(1, candidates.length * strategies.length);
    const rows: OptimizerResultRow[] = [];
    let current = 0;

    updateJobProgress(job, 0, totalRuns, `0/${totalRuns} combinaciones`);
    for (const strategy of strategies) {
      for (const candidate of candidates) {
        throwIfCancelled(job);
        const engine = new MonteCarloEngine(profile, candidate.riskProfile, strategy.trades, iterations, {
          ...randomization,
          seed: `${randomization.seed ?? 'optimizer-v1'}:${strategy.strategy}:${candidate.id}`
        });
        const metrics = engine.run();
        rows.push({
          strategy: strategy.strategy,
          candidate,
          metrics,
          score: scoreRiskAdjustedEV(metrics),
          badges: []
        });
        current += 1;
        updateJobProgress(job, current, totalRuns, `${current}/${totalRuns} combinaciones`);
        await yieldToEventLoop();
      }
    }

    rows.sort((a, b) => b.score - a.score);
    const topRows = rows.slice(0, 50);
    const bestScore = topRows[0]?.score ?? 0;
    const fastestDays = Math.min(...topRows.filter(row => row.metrics.passRatePercent > 0).map(row => row.metrics.avgDaysToPass));
    const bestStability = Math.min(...topRows.map(row => row.metrics.medianMaxConsecutiveLosses));
    topRows.forEach(row => {
      row.badges = badgesFor(row.metrics, row.score, bestScore, fastestDays, bestStability);
    });

    completeJob(job, {
      iterations,
      objective: 'riskAdjustedEV',
      results: topRows,
      candidateCount: candidates.length
    });
  } catch (error: any) {
    failJob(job, error);
  }
}

async function runBankrollJob(job: JobRecord, body: BankrollRequest) {
  try {
    markJobRunning(job, 'Preparando bankroll...');
    const profile = profileStore.read(body.profileId!);
    const riskProfile = buildRiskProfile(body.riskConfig);
    const targetDir = resolveStrategyFolder(body.folder!);
    const requested = new Set((body.strategies || []).map(strategy => path.basename(strategy)));
    const files = fs.readdirSync(targetDir)
      .filter(file => file.endsWith('.csv') && requested.has(file));

    if (files.length === 0) {
      throw new Error('No selected strategies found in the selected folder');
    }

    updateJobProgress(job, 0, files.length, 'Leyendo estrategias bankroll...');
    const strategies = [];
    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      strategies.push({
        strategy: strategyFile,
        trades: await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile))
      });
      updateJobProgress(job, index + 1, files.length, `Leyendo ${index + 1}/${files.length}`);
      await yieldToEventLoop();
    }

    throwIfCancelled(job);
    updateJobProgress(job, 0, Math.max(1, Number(body.iterations || 1000)), 'Simulando curvas bankroll...');
    const engine = new BankrollEngine({
      profile,
      riskProfile,
      strategies,
      request: {
        ...body,
        randomization: buildRandomization(body.randomization)
      }
    });
    const result = await engine.runProgressive({
      onProgress: (current, total) => {
        throwIfCancelled(job);
        updateJobProgress(job, current, total, `${current}/${total} iteraciones bankroll`);
      }
    });
    completeJob(job, result);
  } catch (error: any) {
    failJob(job, error);
  }
}

function createJob(type: JobType): JobRecord {
  const now = Date.now();
  const job: JobRecord = {
    id: `${type}-${now}-${Math.random().toString(36).slice(2)}`,
    type,
    status: 'queued',
    progress: {
      current: 0,
      total: 1,
      percent: 0,
      message: 'En cola...'
    },
    cancelRequested: false,
    createdAt: now,
    updatedAt: now
  };
  jobs.set(job.id, job);
  return job;
}

function markJobRunning(job: JobRecord, message: string) {
  job.status = 'running';
  updateJobProgress(job, job.progress.current, job.progress.total, message);
}

function updateJobProgress(job: JobRecord, current: number, total: number, message: string) {
  const safeTotal = Math.max(1, total);
  job.progress = {
    current,
    total: safeTotal,
    percent: Math.min(100, Math.round((current / safeTotal) * 100)),
    message
  };
  job.updatedAt = Date.now();
}

function completeJob(job: JobRecord, result: unknown) {
  if (job.cancelRequested) {
    failJob(job, new CancelledJobError());
    return;
  }
  job.status = 'completed';
  job.result = result;
  updateJobProgress(job, job.progress.total, job.progress.total, 'Completado');
}

function failJob(job: JobRecord, error: Error) {
  if (error instanceof CancelledJobError) {
    job.status = 'cancelled';
    job.error = 'Corrida cancelada';
    updateJobProgress(job, job.progress.current, job.progress.total, 'Cancelado');
    return;
  }
  console.error(error);
  job.status = 'failed';
  job.error = error.message || 'Job failed';
  updateJobProgress(job, job.progress.current, job.progress.total, job.error);
}

function throwIfCancelled(job: JobRecord) {
  if (job.cancelRequested) throw new CancelledJobError();
}

function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function buildRiskProfile(riskConfig: any): RiskProfile {
  const evalInstrument = normalizeInstrument(riskConfig?.evaluation?.instrument ?? riskConfig?.evaluationInstrument ?? riskConfig?.instrument, 'NQ');
  const fundedPreInstrument = normalizeInstrument(riskConfig?.fundedPrePayout?.instrument ?? riskConfig?.fundedPrePayoutInstrument ?? riskConfig?.fundedInstrument ?? evalInstrument, evalInstrument);
  const fundedPostInstrument = normalizeInstrument(riskConfig?.fundedPostPayout?.instrument ?? riskConfig?.fundedPostPayoutInstrument ?? riskConfig?.fundedInstrument ?? fundedPreInstrument, fundedPreInstrument);
  const evaluationContracts = riskConfig?.evaluation?.contracts ?? riskConfig?.evaluationContracts ?? 2;
  const fundedPrePayoutContracts = riskConfig?.fundedPrePayout?.contracts ?? riskConfig?.fundedPrePayoutContracts ?? 2;
  const fundedPostPayoutContracts = riskConfig?.fundedPostPayout?.contracts ?? riskConfig?.fundedPostPayoutContracts ?? 1;

  return {
    evaluationContracts: Number(evaluationContracts),
    fundedPrePayoutContracts: Number(fundedPrePayoutContracts),
    fundedPostPayoutContracts: Number(fundedPostPayoutContracts),
    pointValue: riskConfig?.pointValue ? Number(riskConfig.pointValue) : pointValueForInstrument(evalInstrument),
    evaluation: {
      instrument: evalInstrument,
      contracts: Number(evaluationContracts),
      pointValue: Number(riskConfig?.evaluation?.pointValue ?? pointValueForInstrument(evalInstrument))
    },
    fundedPrePayout: {
      instrument: fundedPreInstrument,
      contracts: Number(fundedPrePayoutContracts),
      pointValue: Number(riskConfig?.fundedPrePayout?.pointValue ?? pointValueForInstrument(fundedPreInstrument))
    },
    fundedPostPayout: {
      instrument: fundedPostInstrument,
      contracts: Number(fundedPostPayoutContracts),
      pointValue: Number(riskConfig?.fundedPostPayout?.pointValue ?? pointValueForInstrument(fundedPostInstrument))
    },
    commissions: riskConfig?.commissions !== undefined ? Number(riskConfig.commissions) : 4.0,
    useSmartScaling: riskConfig?.useSmartScaling !== undefined ? Boolean(riskConfig.useSmartScaling) : true
  };
}

function buildRandomization(randomization: any): RandomizationConfig {
  const mode = randomization?.mode === 'seeded' ? 'seeded' : 'random';
  return {
    mode,
    seed: mode === 'seeded' ? String(randomization?.seed || 'default-seed') : undefined
  };
}

function resolveStrategyFolder(folder: string): string {
  if (folder === '/') return strategiesDir;
  const targetDir = path.resolve(strategiesDir, folder);
  const strategiesRoot = path.resolve(strategiesDir);
  if (!targetDir.startsWith(strategiesRoot)) {
    throw new Error('Invalid strategy folder');
  }
  return targetDir;
}

app.listen(PORT, () => {
  console.log(`Prop Sim GUI Server running at http://localhost:${PORT}`);
});
