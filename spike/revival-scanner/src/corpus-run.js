// Corpus orchestrator: spawns corpus-stream.js workers over disjoint
// sub-ranges of the configured windows, monitors progress via checkpoint
// files, restarts failed workers (they resume from their checkpoints), and
// writes a final summary.
//
//   node src/corpus-run.js                     # build/load plan, run everything
//   node src/corpus-run.js --windows sol-w1    # run ONE lane (sequential driving)
//   node src/corpus-run.js --status            # print progress and exit
//
// The plan (exact block ranges) is computed ONCE and persisted to
// data/corpus/plan.json so restarts of the orchestrator reuse identical
// ranges. Delete that file to re-plan.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAINS, estimateHead } from './corpus/chains.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data');
const CORPUS = path.join(DATA, 'corpus');
const LOGS = path.join(CORPUS, 'logs');
const PLAN_PATH = path.join(CORPUS, 'plan.json');
fs.mkdirSync(LOGS, { recursive: true });

const DAY = 86400;
const MAX_ATTEMPTS = 60; // ECONNRESET storms: each retry still banks checkpointed progress, so grind through

function buildPlan() {
  const headSol = estimateHead('solana');
  const headBsc = estimateHead('bsc');
  const solPerDay = Math.round(CHAINS.solana.blkPerSec * DAY); // ~207k
  const bscPerDay = Math.round(CHAINS.bsc.blkPerSec * DAY);    // ~192k

  const windows = [
    // Two Solana windows ~3 chain-days each inside the last 30 days:
    // W1 (train): 25 -> 22 days ago.  W2 (test): 4.2 -> 1.2 days ago.
    { chain: 'solana', name: 'sol-w1', start: headSol - 25 * solPerDay, stop: headSol - 22 * solPerDay, workers: 4 },
    { chain: 'solana', name: 'sol-w2', start: headSol - Math.round(4.2 * solPerDay), stop: headSol - Math.round(1.2 * solPerDay), workers: 4 },
    // BSC: 7 recent chain-days as one window (train/test split by timestamp).
    { chain: 'bsc', name: 'bsc-w1', start: headBsc - Math.round(7.2 * bscPerDay), stop: headBsc - Math.round(0.2 * bscPerDay), workers: 7 },
  ];

  const tasks = [];
  for (const w of windows) {
    const span = w.stop - w.start;
    const per = Math.ceil(span / w.workers);
    for (let i = 0; i < w.workers; i++) {
      const start = w.start + i * per;
      const stop = Math.min(w.stop, start + per);
      tasks.push({
        chain: w.chain, window: w.name, id: `${w.name}-p${i}`,
        start, stop,
        out: path.join(CORPUS, w.chain, w.name),
      });
    }
  }
  return { createdAt: new Date().toISOString(), headSol, headBsc, windows, tasks };
}

function loadPlan() {
  if (fs.existsSync(PLAN_PATH)) return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  const plan = buildPlan();
  fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 1));
  return plan;
}

function readCkpt(task) {
  const p = path.join(task.out, `${task.id}.ckpt.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function progressLine(plan, windowFilter = null) {
  const parts = [];
  let allDone = true;
  for (const w of plan.windows) {
    if (windowFilter && !windowFilter.includes(w.name)) continue;
    const tasks = plan.tasks.filter((t) => t.window === w.name);
    let done = 0, total = 0, rows = 0, finished = 0;
    for (const t of tasks) {
      total += t.stop - t.start;
      const ck = readCkpt(t);
      if (ck) {
        done += Math.min(t.stop, (ck.lastBlock ?? t.start - 1) + 1) - t.start;
        rows += ck.rowsWritten ?? 0;
        if (ck.done) finished += 1;
      }
    }
    if (finished < tasks.length) allDone = false;
    parts.push(`${w.name} ${(100 * done / total).toFixed(1)}% (${finished}/${tasks.length} workers done, ${(rows / 1000).toFixed(0)}k rows)`);
  }
  return { line: parts.join(' | '), allDone };
}

const plan = loadPlan();
const wIdx = process.argv.indexOf('--windows');
const windowFilter = wIdx >= 0 ? process.argv[wIdx + 1].split(',') : null;
const activeTasks = windowFilter
  ? plan.tasks.filter((t) => windowFilter.includes(t.window))
  : plan.tasks;

if (process.argv.includes('--status')) {
  console.log(progressLine(plan, windowFilter).line);
  process.exit(0);
}

console.log(`plan: ${activeTasks.length} workers${windowFilter ? ` (lanes: ${windowFilter})` : ''} (created ${plan.createdAt})`);
for (const w of plan.windows) {
  if (windowFilter && !windowFilter.includes(w.name)) continue;
  console.log(`  ${w.name}: [${w.start}, ${w.stop}) = ${((w.stop - w.start) / 1000).toFixed(0)}k blocks, ${w.workers} workers`);
}

const running = new Map(); // id -> child
const attempts = new Map();
let quotaStrikes = 0;

function launch(task) {
  const ck = readCkpt(task);
  if (ck?.done) { onExit(task, 0, true); return; }
  const logPath = path.join(LOGS, `${task.id}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, [
    // Hard heap cap: without it, workers creep to multi-GB (lazy GC + eager
    // stream buffering), starve the whole box, and take the orchestrator down
    // with them (observed twice on 2026-08-04). A capped worker either stays
    // small or OOMs alone — and the retry loop below resumes it from its
    // checkpoint for pennies.
    '--max-old-space-size=1024',
    path.join(HERE, 'corpus-stream.js'),
    '--chain', task.chain, '--start', String(task.start), '--stop', String(task.stop),
    '--out', task.out, '--id', task.id,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  let sawQuota = false;
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (/429|quota|exhausted|payment|limit/i.test(s)) sawQuota = true;
  });
  child.on('exit', (code) => { onExit(task, code, false, sawQuota); });
  running.set(task.id, child);
  console.log(`[run] launched ${task.id} [${task.start}, ${task.stop})${ck ? ' (resume)' : ''}`);
}

function onExit(task, code, alreadyDone = false, sawQuota = false) {
  running.delete(task.id);
  if (alreadyDone || code === 0) {
    console.log(`[run] ${task.id} complete`);
    maybeFinish();
    return;
  }
  const n = (attempts.get(task.id) ?? 0) + 1;
  attempts.set(task.id, n);
  if (sawQuota) quotaStrikes += 1;
  if (n >= MAX_ATTEMPTS) {
    console.error(`[run] ${task.id} FAILED permanently after ${n} attempts`);
    maybeFinish();
    return;
  }
  const backoff = Math.min(300_000, (sawQuota ? 60_000 : 10_000) * n);
  console.error(`[run] ${task.id} exited code=${code}${sawQuota ? ' (quota?)' : ''}; retry #${n} in ${backoff / 1000}s`);
  setTimeout(() => launch(task), backoff);
}

function maybeFinish() {
  const { line, allDone } = progressLine(plan, windowFilter);
  if (running.size === 0 && allDone) {
    console.log(`[run] ALL DONE — ${line}`);
    const summary = { finishedAt: new Date().toISOString(), quotaStrikes, lanes: windowFilter, tasks: activeTasks.map((t) => ({ id: t.id, ckpt: readCkpt(t) })) };
    fs.writeFileSync(path.join(CORPUS, windowFilter ? `run-summary-${windowFilter.join('+')}.json` : 'run-summary.json'), JSON.stringify(summary, null, 1));
    process.exit(0);
  }
  if (running.size === 0) {
    // nothing running but not all done -> retries pending or permanent failures
    const pendingRetries = [...attempts.values()].some((n) => n < MAX_ATTEMPTS);
    if (!pendingRetries) {
      console.error('[run] halted with permanent failures; see logs');
      process.exit(1);
    }
  }
}

for (const t of activeTasks) launch(t);

setInterval(() => {
  console.log(`[run ${new Date().toISOString()}] ${progressLine(plan, windowFilter).line} | active=${running.size} quotaStrikes=${quotaStrikes}`);
}, 120_000);
