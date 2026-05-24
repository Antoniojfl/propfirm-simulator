import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { TradeParser } from './tradeParser';
import { MonteCarloEngine } from './monteCarloEngine';
import { PropFirmProfile, RandomizationConfig, RiskProfile, TradeSanitizationConfig } from './types';
import { ProfileStore, ProfileValidationError } from './profileStore';
import { createRunSeed } from './random';
import { normalizeInstrument, pointValueForInstrument } from './instruments';
import { generateCandidates } from './optimizer/candidateGenerator';
import { badgesFor, scoreRiskAdjustedEV } from './optimizer/scoring';
import { OptimizerRequest, OptimizerResultRow } from './optimizer/types';
import { BankrollEngine } from './bankroll/bankrollEngine';
import { BankrollRequest } from './bankroll/types';
import { MonteCarloResults } from './monteCarloEngine';
import { DailyPnlPoint } from './live/types';
import { buildDailyPointSeries } from './live/dailySeries';
import { buildLivePortfolio } from './live/portfolioSelector';
import { NormalizedTradeSanitizationConfig, normalizeSanitizationConfig, sanitizeTrades, TradeSanitizationReport } from './tradeSanitizer';
import { LiveSelectionEngine } from './liveSelection/liveSelectionEngine';
import { DEFAULT_LIVE_SELECTION_FOLDER, LiveSelectionRequest } from './liveSelection/types';
import { HistoricalReplayEngine } from './historicalReplay/historicalReplayEngine';
import { HistoricalReplayRequest, HistoricalReplayResponse } from './historicalReplay/types';
import { prepareHistoricalDailyTrades } from './historicalReplay/tradeSequence';

interface SimulationResultCache {
  strategy: string;
  fundedStrategy?: string;
  metrics: MonteCarloResults;
  dailySeries: DailyPnlPoint[];
}

interface SimulationSession {
  id: string;
  profileId: string;
  folder: string;
  fundedFolder?: string;
  riskProfile: RiskProfile;
  randomization: RandomizationConfig;
  sanitization: NormalizedTradeSanitizationConfig;
  effectiveSeed: string;
  results: SimulationResultCache[];
  createdAt: number;
}

interface HistoricalReplayResultCache extends HistoricalReplayResponse {
  strategy: string;
  fundedStrategy?: string;
}

interface HistoricalReplaySession {
  id: string;
  profile: string;
  folder?: string;
  fundedFolder?: string;
  results: HistoricalReplayResultCache[];
  createdAt: number;
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!error) return next();
  res.status(error.status || 400).json({ error: error.message || 'Invalid request payload' });
});
app.use(express.static(path.join(__dirname, '../public')));

const configDir = path.join(__dirname, '../config/prop_firms');
const strategiesDir = path.join(__dirname, '../strategies');
const profileStore = new ProfileStore(configDir);
const sessions = new Map<string, SimulationSession>();
const historicalReplaySessions = new Map<string, HistoricalReplaySession>();
const jobs = new Map<string, JobRecord>();

type JobType = 'simulation' | 'optimizer' | 'bankroll' | 'liveSelection' | 'historicalReplay';
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

app.get('/api/strategies', (req, res) => {
  try {
    const folder = typeof req.query.folder === 'string' ? req.query.folder : '/';
    const targetDir = resolveStrategyFolder(folder);
    const files = fs.readdirSync(targetDir)
      .filter(file => file.endsWith('.csv'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    res.json({ folder, strategies: files });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to load strategies' });
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
  const { profileId, folder, evalFolder, fundedFolder, riskConfig, randomization, sanitization } = req.body;
  const resolvedFolder = folder || evalFolder;
  if (!profileId || !resolvedFolder) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const job = createJob('simulation');
  res.status(202).json({ jobId: job.id });
  setTimeout(() => {
    void runSimulationJob(job, { profileId, folder: resolvedFolder, fundedFolder, riskConfig, randomization, sanitization });
  }, 100);
});

app.post('/api/optimize', async (req, res) => {
  const body = req.body as OptimizerRequest & { profileId?: string; folder?: string; strategy?: string };
  if (!body.profileId || !body.folder) {
    return res.status(400).json({ error: 'Invalid optimizer payload' });
  }

  const job = createJob('optimizer');
  res.status(202).json({ jobId: job.id });
  setTimeout(() => {
    void runOptimizerJob(job, body);
  }, 100);
});

app.post('/api/bankroll/simulate', async (req, res) => {
  const body = req.body as BankrollRequest;
  if (!body.profileId || !body.folder || !body.strategies?.length) {
    return res.status(400).json({ error: 'Invalid bankroll payload' });
  }

  const job = createJob('bankroll');
  res.status(202).json({ jobId: job.id });
  setTimeout(() => {
    void runBankrollJob(job, body);
  }, 100);
});

app.post('/api/live-selection/run', async (req, res) => {
  const body = req.body as LiveSelectionRequest;
  if (!body.profileId) {
    return res.status(400).json({ error: 'Invalid live selection payload' });
  }

  const job = createJob('liveSelection');
  res.status(202).json({ jobId: job.id });
  setTimeout(() => {
    void runLiveSelectionJob(job, body);
  }, 100);
});

app.post('/api/historical-replay/run', async (req, res) => {
  const body = req.body as HistoricalReplayRequest;
  if (!body.profileId || !body.folder || !body.strategies?.length) {
    return res.status(400).json({ error: 'Invalid historical replay payload' });
  }

  const job = createJob('historicalReplay');
  res.status(202).json({ jobId: job.id });
  setTimeout(() => {
    void runHistoricalReplayJob(job, body);
  }, 100);
});

app.get('/api/historical-replay/:id/detail', (req, res) => {
  const session = historicalReplaySessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Historical replay session not found' });

  const strategy = path.basename(String(req.query.strategy || ''));
  const detail = session.results.find(row => row.strategy === strategy);
  if (!detail) return res.status(404).json({ error: 'Historical replay strategy not found' });

  res.json(detail);
});

app.post('/api/live/portfolio', (req, res) => {
  const sessionId = String(req.body?.simulationId || '');
  const session = sessions.get(sessionId);
  if (!session || !session.results.length) {
    return res.status(400).json({ error: 'Primero ejecuta el simulador para generar estrategias disponibles.' });
  }

  res.json(buildLivePortfolio({
    strategies: session.results,
    topN: req.body?.topN,
    diversityWeight: req.body?.diversityWeight,
    minOverlapDays: req.body?.minOverlapDays
  }));
});

app.get('/api/simulations/:id/strategies/:strategy/traces', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Simulation session not found' });

  try {
    const profile = profileStore.read(session.profileId);
    const targetDir = resolveStrategyFolder(session.folder);
    const fundedTargetDir = resolveStrategyFolder(session.fundedFolder || session.folder);
    const strategy = decodeURIComponent(req.params.strategy);
    const safeStrategy = path.basename(strategy);
    const csvPath = path.join(targetDir, safeStrategy);
    if (!fs.existsSync(csvPath) || !safeStrategy.endsWith('.csv')) {
      return res.status(404).json({ error: 'Strategy file not found' });
    }

    const trades = await TradeParser.parseSqxCsv(csvPath);
    const fundedStrategy = session.results.find(row => row.strategy === safeStrategy)?.fundedStrategy || safeStrategy;
    const fundedCsvPath = path.join(fundedTargetDir, path.basename(fundedStrategy));
    const fundedTrades = fs.existsSync(fundedCsvPath) ? await TradeParser.parseSqxCsv(fundedCsvPath) : undefined;
    const strategySeed = `${session.effectiveSeed}:${safeStrategy}`;
    const engine = new MonteCarloEngine(profile, session.riskProfile, trades, 5, {
      ...session.randomization,
      seed: strategySeed
    }, session.sanitization, fundedTrades);
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
  fundedFolder?: string;
  riskConfig: any;
  randomization: any;
  sanitization: any;
}) {
  try {
    markJobRunning(job, 'Preparando simulacion...');
    const profile = profileStore.read(input.profileId);
    const riskProfile = buildRiskProfile(input.riskConfig);
    const randomizationConfig = buildRandomization(input.randomization);
    const sanitizationConfig = normalizeSanitizationConfig(input.sanitization);
    const sessionId = `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const effectiveSeed = createRunSeed(randomizationConfig.seed);
    const targetDir = resolveStrategyFolder(input.folder);
    const fundedTargetDir = resolveStrategyFolder(input.fundedFolder || input.folder);
    const files = fs.readdirSync(targetDir).filter(file => file.endsWith('.csv'));
    const fundedFiles = fs.readdirSync(fundedTargetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No evaluation strategies found in the selected folder');
    }
    if (fundedFiles.length === 0) {
      throw new Error('No funded strategies found in the selected folder');
    }

    const results: SimulationResultCache[] = [];
    const sanitizationReports: Array<{ strategy: string; report: TradeSanitizationReport }> = [];
    const iterationsPerStrategy = 1000;
    const totalUnits = files.length * iterationsPerStrategy;
    updateJobProgress(job, 0, totalUnits, `0/${files.length} estrategias`);

    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      updateJobProgress(job, index * iterationsPerStrategy, totalUnits, `Leyendo ${strategyFile}`);
      const parsedTrades = await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile));
      const fundedStrategyFile = selectFundedStrategy(strategyFile, fundedFiles, index);
      const fundedTrades = await TradeParser.parseSqxCsv(path.join(fundedTargetDir, fundedStrategyFile));
      const { report } = sanitizeTrades(parsedTrades, sanitizationConfig);
      const strategySeed = `${effectiveSeed}:${strategyFile}`;
      const engine = new MonteCarloEngine(profile, riskProfile, parsedTrades, iterationsPerStrategy, {
        ...randomizationConfig,
        seed: strategySeed
      }, sanitizationConfig, fundedTrades);
      const { metrics } = await engine.runWithTracesProgressive(0, {
          yieldEvery: 5,
          shouldCancel: () => {
            throwIfCancelled(job);
            return false;
          },
          onProgress: (iteration, total) => {
            const current = index * iterationsPerStrategy + iteration;
            updateJobProgress(job, current, totalUnits, `${index + 1}/${files.length} ${strategyFile} (${iteration}/${total})`);
          }
        });
      results.push({
        strategy: strategyFile,
        fundedStrategy: fundedStrategyFile,
        metrics,
        dailySeries: buildDailyPointSeries(parsedTrades)
      });
      sanitizationReports.push({ strategy: strategyFile, report });
      updateJobProgress(job, (index + 1) * iterationsPerStrategy, totalUnits, `${index + 1}/${files.length} estrategias`);
      await yieldToEventLoop();
    }

    sessions.set(sessionId, {
      id: sessionId,
      profileId: input.profileId,
      folder: input.folder,
      fundedFolder: input.fundedFolder || input.folder,
      riskProfile,
      randomization: randomizationConfig,
      sanitization: sanitizationConfig,
      effectiveSeed,
      results,
      createdAt: Date.now()
    });

    completeJob(job, {
      simulationId: sessionId,
      randomization: {
        mode: randomizationConfig.mode,
        seed: effectiveSeed
      },
      sanitization: {
        config: sanitizationConfig,
        reports: sanitizationReports
      },
      results: results.map(({ strategy, fundedStrategy, metrics }) => ({ strategy, fundedStrategy, metrics }))
    });
  } catch (error: any) {
    failJob(job, error);
  }
}

function selectFundedStrategy(evalStrategy: string, fundedFiles: string[], index: number): string {
  if (fundedFiles.includes(evalStrategy)) return evalStrategy;
  return fundedFiles[index % fundedFiles.length];
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
        }, normalizeSanitizationConfig(body.sanitization));
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
    const fundedTargetDir = resolveStrategyFolder(body.fundedFolder || body.folder!);
    const requested = new Set((body.strategies || []).map(strategy => path.basename(strategy)));
    const files = fs.readdirSync(targetDir)
      .filter(file => file.endsWith('.csv') && requested.has(file));
    const fundedFiles = fs.readdirSync(fundedTargetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No selected strategies found in the selected folder');
    }
    if (fundedFiles.length === 0) {
      throw new Error('No funded strategies found in the selected folder');
    }

    updateJobProgress(job, 0, files.length, 'Leyendo estrategias bankroll...');
    const strategies = [];
    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      const fundedStrategyFile = selectFundedStrategy(strategyFile, fundedFiles, index);
      strategies.push({
        strategy: strategyFile,
        fundedStrategy: fundedStrategyFile,
        trades: await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile)),
        fundedTrades: await TradeParser.parseSqxCsv(path.join(fundedTargetDir, fundedStrategyFile))
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
      sanitization: normalizeSanitizationConfig(body.sanitization),
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

async function runHistoricalReplayJob(job: JobRecord, body: HistoricalReplayRequest) {
  try {
    markJobRunning(job, 'Preparando historical replay...');
    const profile = profileStore.read(body.profileId!);
    const riskProfile = {
      ...buildRiskProfile(body.riskConfig),
      useSmartScaling: false,
      useFundedTacticalPayoutTrade: false
    };
    const historicalSanitization = normalizeSanitizationConfig({
      ...body.sanitization,
      mode: 'fixedOutcome'
    });
    const targetDir = resolveStrategyFolder(body.folder!);
    const fundedTargetDir = resolveStrategyFolder(body.fundedFolder || body.folder!);
    const requested = new Set((body.strategies || []).map(strategy => path.basename(strategy)));
    const files = fs.readdirSync(targetDir)
      .filter(file => file.endsWith('.csv') && requested.has(file));
    const fundedFiles = fs.readdirSync(fundedTargetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No selected strategies found in the selected folder');
    }
    if (fundedFiles.length === 0) {
      throw new Error('No funded strategies found in the selected folder');
    }

    updateJobProgress(job, 0, files.length, 'Corriendo historical replay por estrategia...');
    const results: HistoricalReplayResultCache[] = [];
    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      const fundedStrategyFile = selectFundedStrategy(strategyFile, fundedFiles, index);
      const strategyInput = {
        strategy: strategyFile,
        fundedStrategy: fundedStrategyFile,
        trades: prepareHistoricalDailyTrades(await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile))),
        fundedTrades: prepareHistoricalDailyTrades(await TradeParser.parseSqxCsv(path.join(fundedTargetDir, fundedStrategyFile)))
      };
      const engine = new HistoricalReplayEngine({
        profile,
        riskProfile,
        strategies: [strategyInput],
        request: { ...body, strategies: [strategyFile] },
        sanitization: historicalSanitization
      });
      const replay = engine.run({
        shouldCancel: () => {
          throwIfCancelled(job);
        },
        onProgress: (current, total, message) => {
          const unitProgress = total > 0 ? current / total : 1;
          updateJobProgress(job, index + unitProgress, files.length, `${strategyFile}: ${message}`);
        }
      });
      results.push({
        strategy: strategyFile,
        fundedStrategy: fundedStrategyFile,
        ...replay
      });
      updateJobProgress(job, index + 1, files.length, `Replay ${index + 1}/${files.length}`);
      await yieldToEventLoop();
    }

    throwIfCancelled(job);
    const sortedResults = results.sort((a, b) => b.netProfit - a.netProfit);
    const replayId = `historicalReplaySession-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    historicalReplaySessions.set(replayId, {
      id: replayId,
      profile: profile.firm_name,
      folder: body.folder,
      fundedFolder: body.fundedFolder || body.folder,
      results: sortedResults,
      createdAt: Date.now()
    });
    completeJob(job, {
      replayId,
      profile: profile.firm_name,
      folder: body.folder,
      fundedFolder: body.fundedFolder || body.folder,
      results: sortedResults.map(summarizeHistoricalReplayResult),
      summary: {
        strategies: sortedResults.length,
        totalNetProfit: sortedResults.reduce((sum, item) => sum + item.netProfit, 0),
        totalPayouts: sortedResults.reduce((sum, item) => sum + item.payoutsTaken, 0),
        totalAccountsPurchased: sortedResults.reduce((sum, item) => sum + item.accountsPurchased, 0),
        totalAccountsBlown: sortedResults.reduce((sum, item) => sum + item.accountsBlown, 0),
        bestStrategy: sortedResults[0]?.strategy || null
      }
    });
  } catch (error: any) {
    failJob(job, error);
  }
}

async function runLiveSelectionJob(job: JobRecord, body: LiveSelectionRequest) {
  try {
    markJobRunning(job, 'Preparando live selection...');
    const profile = profileStore.read(body.profileId!);
    const riskProfile = buildRiskProfile(body.riskConfig);
    const folder = body.folder || DEFAULT_LIVE_SELECTION_FOLDER;
    const targetDir = resolveStrategyFolder(folder);
    const files = fs.readdirSync(targetDir).filter(file => file.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error('No strategies found in the selected folder');
    }

    const sanitization = normalizeSanitizationConfig(body.sanitization ?? { mode: 'fixedOutcome' });
    const strategies = [];
    updateJobProgress(job, 0, files.length, `Leyendo ${files.length} estrategias live...`);

    for (const [index, strategyFile] of files.entries()) {
      throwIfCancelled(job);
      const parsedTrades = await TradeParser.parseSqxCsv(path.join(targetDir, strategyFile));
      strategies.push({ strategy: strategyFile, trades: parsedTrades });
      updateJobProgress(job, index + 1, files.length, `Preparando ${index + 1}/${files.length}`);
      await yieldToEventLoop();
    }

    throwIfCancelled(job);
    updateJobProgress(job, 0, strategies.length, 'Corriendo matriz OOS y Monte Carlo...');
    const engine = new LiveSelectionEngine({
      profile,
      riskProfile,
      strategies,
      randomization: buildRandomization(body.randomization ?? { mode: 'seeded', seed: 'live-selection-v1' }),
      config: body.config,
      sanitization
    });
    const result = await engine.runProgressive({
      onProgress: (current, total, strategy) => {
        throwIfCancelled(job);
        updateJobProgress(job, current, total, strategy === 'Completado' ? 'Completado' : `Evaluando ${current + 1}/${total}: ${strategy}`);
      },
      yieldToEventLoop
    });
    completeJob(job, {
      folder,
      sanitization,
      result: stripLiveSelectionDailySeries(result)
    });
  } catch (error: any) {
    failJob(job, error);
  }
}

function stripLiveSelectionDailySeries(result: any) {
  const stripRow = (row: any) => ({
    ...row,
    dailySeries: undefined
  });
  return {
    ...result,
    portfolio: (result.portfolio || []).map(stripRow),
    candidates: (result.candidates || []).map(stripRow),
    watchlist: (result.watchlist || []).map(stripRow),
    rejected: (result.rejected || []).map(stripRow),
    nearMisses: (result.nearMisses || []).map(stripRow)
  };
}

function summarizeHistoricalReplayResult(result: HistoricalReplayResultCache) {
  const { eventTimeline, dailyCurve, ...summary } = result;
  return {
    ...summary,
    eventCount: eventTimeline.length,
    curvePoints: dailyCurve.length
  };
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
  const fundedInstrument = normalizeInstrument(riskConfig?.funded?.instrument ?? riskConfig?.fundedPrePayout?.instrument ?? riskConfig?.fundedPrePayoutInstrument ?? riskConfig?.fundedInstrument ?? evalInstrument, evalInstrument);
  const evaluationContracts = Math.max(1, Number(riskConfig?.evaluation?.contracts ?? riskConfig?.evaluationContracts ?? 2));
  const fundedContracts = Math.max(1, Number(riskConfig?.funded?.contracts ?? riskConfig?.fundedContracts ?? riskConfig?.fundedPrePayout?.contracts ?? riskConfig?.fundedPrePayoutContracts ?? 2));

  return {
    evaluationContracts,
    fundedPrePayoutContracts: fundedContracts,
    fundedPostPayoutContracts: fundedContracts,
    pointValue: riskConfig?.pointValue ? Number(riskConfig.pointValue) : pointValueForInstrument(evalInstrument),
    evaluation: {
      instrument: evalInstrument,
      contracts: evaluationContracts,
      pointValue: Number(riskConfig?.evaluation?.pointValue ?? pointValueForInstrument(evalInstrument))
    },
    fundedPrePayout: {
      instrument: fundedInstrument,
      contracts: fundedContracts,
      pointValue: Number(riskConfig?.funded?.pointValue ?? riskConfig?.fundedPrePayout?.pointValue ?? pointValueForInstrument(fundedInstrument))
    },
    fundedPostPayout: {
      instrument: fundedInstrument,
      contracts: fundedContracts,
      pointValue: Number(riskConfig?.funded?.pointValue ?? riskConfig?.fundedPostPayout?.pointValue ?? pointValueForInstrument(fundedInstrument))
    },
    commissions: 0,
    useSmartScaling: riskConfig?.useSmartScaling !== undefined ? Boolean(riskConfig.useSmartScaling) : true,
    useFundedTacticalPayoutTrade: riskConfig?.useFundedTacticalPayoutTrade !== undefined ? Boolean(riskConfig.useFundedTacticalPayoutTrade) : false,
    tacticalPayoutWinRate: riskConfig?.tacticalPayoutWinRate !== undefined ? Number(riskConfig.tacticalPayoutWinRate) : 0.7,
    tacticalPayoutRiskReward: riskConfig?.tacticalPayoutRiskReward !== undefined ? Number(riskConfig.tacticalPayoutRiskReward) : 4
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

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`Prop Sim GUI Server running at http://localhost:${PORT}`);
});
