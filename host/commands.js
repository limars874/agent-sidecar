// The CLI host: every command is one short-lived process. State between
// events lives only in the session's state directory.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { loadConfig } from '../core/config.js';
import { publishFeedback } from '../core/feedback.js';
import { validateEvent } from '../core/event.js';
import { loadItems } from '../core/items.js';
import { ensureSessionMetadata } from '../core/outputs.js';
import { BIN_PATH, itemsDir, sessionDir } from '../core/paths.js';
import { getSessionContext } from '../core/session.js';
import { runItem } from '../core/runner.js';
import {
  completeIdlePrompt,
  markIdlePromptScheduleFailed,
  markIdlePromptScheduled,
  markIdlePromptTriggered,
  planIdlePrompt,
  publishIdlePromptPlan,
} from '../core/idle-prompt.js';
import { planEvent } from '../core/scheduler.js';
import { getRunner, resolveRunnerName } from '../runners/index.js';
import { appendLine, readState, runIsStale, updateState, updateStateAsync, writeJsonAtomic, writeState } from '../core/state.js';
import { countTurns } from '../core/transcript.js';

const LOG_FILE = 'sidecar.log';
const RUNS_FILE = 'runs.jsonl';

function log(dir, message) {
  appendLine(path.join(dir, LOG_FILE), `${new Date().toISOString()} ${message}`);
}

function loadItemsLogged(root, dir) {
  const { items, errors } = loadItems(itemsDir(root));
  for (const e of errors) log(dir, `item skipped: ${e.file}: ${e.message}`);
  return items;
}

function prepareSessionMetadata(root, event, sessionContext, dir) {
  try {
    const metadata = ensureSessionMetadata({ root, event, sessionContext });
    if (metadata.warning) log(dir, metadata.warning);
  } catch (err) {
    log(dir, `session metadata failed: ${err.message}`);
  }
}

function handleIdlePromptActivity(event, dir) {
  if (event.activity === 'idle-prompt-triggered') {
    const result = updateState(dir, (state) => {
      const marked = markIdlePromptTriggered(state, { idlePromptId: event.idlePromptId });
      return { state: marked.state, matched: marked.matched };
    });
    if (result.matched) log(dir, `idle prompt ${event.idlePromptId} triggered`);
    return { job: null, turn: event.turn ?? null, scheduled: [], skipped: [], idle: { status: 'triggered', matched: result.matched } };
  }

  const result = updateState(dir, (state) => {
    const completed = completeIdlePrompt(state, { idlePromptId: event.idlePromptId });
    return { state: completed.state, matched: completed.matched, check: completed.check };
  });
  if (result.matched) log(dir, `idle prompt ${event.idlePromptId} completed`);
  return { job: null, turn: event.turn ?? null, scheduled: [], skipped: [], idle: { status: 'completed', matched: result.matched } };
}

// `agent-sidecar event`: decide what is due, record it, hand it to a detached worker.
export async function handleEvent(rawEvent, { root, env, foreground = false, feedbackConnect, idleConnect, idleManager } = {}) {
  const event = validateEvent(rawEvent, Object.keys(ADAPTERS));
  const dir = sessionDir(root, event.agent, event.session);
  if ((event.activity ?? 'work') !== 'work') return handleIdlePromptActivity(event, dir);

  const config = loadConfig(root);
  for (const warning of config.warnings ?? []) log(dir, warning);
  const adapter = getAdapter(event.agent);
  const sessionInfo = adapter.readSessionInfo
    ? adapter.readSessionInfo(event.transcriptRef)
    : adapter.readTranscript(event.transcriptRef);
  const sessionContext = getSessionContext(sessionInfo, event);
  prepareSessionMetadata(root, event, sessionContext, dir);
  const items = loadItemsLogged(root, dir);
  const turn = event.turn ?? countTurns(sessionInfo.messages ?? adapter.readTranscript(event.transcriptRef).messages);

  const job = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const planned = await updateStateAsync(dir, async (state) => {
    const itemPlan = planEvent({ items, state, turn, job, now: new Date().toISOString(), isStale: (r) => runIsStale(r) });
    const idlePlan = planIdlePrompt({ state: itemPlan.state, event, config });
    let finalState = idlePlan.state;
    let idle = null;
    if (idlePlan.action) {
      // 在网络调用前先持久化 pending 计划；进程若在发布后退出，下一次事件会用同一个 msgID 重试，若在发布前退出，也不会丢失计划。
      writeState(dir, finalState);
      const result = await publishIdlePromptPlan({
        config,
        event,
        plan: idlePlan.action.plan,
        previousPlan: idlePlan.action.previousPlan,
        connect: idleConnect,
        manager: idleManager,
      });
      idle = { status: result.scheduled ? 'scheduled' : 'pending', warning: result.warning };
      finalState = result.scheduled
        ? markIdlePromptScheduled(finalState, idlePlan.action.plan.id)
        : markIdlePromptScheduleFailed(finalState, idlePlan.action.plan.id, result.warning);
      if (result.warning) log(dir, result.warning);
    } else if (config.idle.enabled && turn > 0 && !event.idleRoute) {
      idle = { status: 'skipped', warning: 'idle route unavailable' };
      log(dir, idle.warning);
    }
    return {
      state: finalState,
      due: itemPlan.due,
      skipped: itemPlan.skipped,
      idle,
    };
  });
  const { due, skipped, idle } = planned;

  if (due.length === 0) return { job: null, turn, scheduled: [], skipped, idle };

  const jobFile = path.join(dir, 'jobs', `${job}.json`);
  writeJsonAtomic(jobFile, { v: 1, id: job, event: { ...event, turn }, items: due });
  log(dir, `job ${job} turn ${turn}: ${due.map((d) => d.name).join(', ')}`);

  if (foreground) {
    await work(jobFile, { root, env, feedbackConnect });
  } else {
    const out = fs.openSync(path.join(dir, LOG_FILE), 'a');
    spawn(process.execPath, [BIN_PATH, 'work', jobFile], { detached: true, stdio: ['ignore', out, out], env }).unref();
    fs.closeSync(out);
  }
  return { job, turn, scheduled: due.map((d) => d.name), skipped, idle };
}

// `agent-sidecar work <job>` (internal): run a job's items one after another.
export async function work(jobFile, { root, env, feedbackConnect }) {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const { event } = job;
  const dir = sessionDir(root, event.agent, event.session);
  updateState(dir, (state) => {
    for (const d of job.items) {
      const running = state.items[d.name]?.running;
      if (running?.job === job.id) running.pid = process.pid;
    }
    return { state };
  });

  const results = [];
  let config, items, transcript, sessionContext, setupError;
  try {
    config = loadConfig(root);
    items = loadItemsLogged(root, dir);
    transcript = getAdapter(event.agent).readTranscript(event.transcriptRef);
    sessionContext = getSessionContext(transcript, event);
    prepareSessionMetadata(root, event, sessionContext, dir);
  } catch (err) {
    setupError = err.message;
  }

  for (const d of job.items) {
    const started = Date.now();
    const record = { at: new Date().toISOString(), job: job.id, item: d.name, fromTurn: d.fromTurn, toTurn: d.toTurn };
    try {
      if (setupError) throw new Error(setupError);
      const item = items.find((i) => i.name === d.name);
      if (!item) throw new Error('item no longer exists or failed to load');
      const runnerName = resolveRunnerName(item, config);
      const runner = getRunner(runnerName);
      const r = runItem({
        item,
        runner,
        transcript,
        event,
        config,
        root,
        sessionDir: dir,
        fromTurn: d.fromTurn,
        toTurn: d.toTurn,
        env,
        now: new Date(),
        sessionContext,
      });
      const warnings = [...r.output.warnings];
      if (item.feedback) {
        const feedback = await publishFeedback({
          item,
          event,
          content: r.text,
          sourceTurn: d.toTurn,
          config,
          connect: feedbackConnect,
        });
        if (feedback.warning) warnings.push(feedback.warning);
      }
      Object.assign(record, { status: 'ok', runner: runnerName, model: r.model, effort: r.effort, written: r.output.written, warnings });
      for (const w of warnings) log(dir, `${d.name}: ${w}`);
    } catch (err) {
      Object.assign(record, { status: 'error', error: err.message });
      log(dir, `${d.name}: ${err.message}`);
    }
    record.ms = Date.now() - started;
    results.push(record);
    appendLine(path.join(dir, RUNS_FILE), record);
    updateState(dir, (state) => {
      const s = state.items[d.name];
      if (s?.running?.job !== job.id) return { state };
      delete s.running;
      s.lastRun = { at: record.at, status: record.status, fromTurn: d.fromTurn, toTurn: d.toTurn, error: record.error };
      if (record.status === 'ok') {
        s.completedThrough = d.toTurn;
        s.lastTurn = d.toTurn;
        s.scheduledThrough = Math.max(s.scheduledThrough ?? 0, d.toTurn);
      }
      return { state };
    });
  }
  fs.rmSync(jobFile, { force: true });
  return results;
}

// `agent-sidecar run <item>`: run one item now over a session file. It ignores
// everyTurns and does not move the item's cursor.
export function runManual({ name, agent, sessionFile, model, pane, fromTurn, toTurn, dryRun, root, env }) {
  const adapter = getAdapter(agent);
  const config = loadConfig(root);
  const { items, errors } = loadItems(itemsDir(root));
  const item = items.find((i) => i.name === name);
  if (!item) {
    const err = errors.find((e) => path.basename(e.file, path.extname(e.file)) === name);
    throw new Error(err ? `${err.file}: ${err.message}` : `no item "${name}" in ${itemsDir(root)}`);
  }

  const transcript = adapter.readTranscript(sessionFile);
  const turns = countTurns(transcript.messages);
  const event = validateEvent(
    { v: 1, agent, session: transcript.session, transcriptRef: sessionFile, model: model ?? transcript.model ?? null, pane: pane ?? null, turn: turns },
    Object.keys(ADAPTERS),
  );
  const dir = sessionDir(root, agent, event.session);
  const sessionContext = getSessionContext(transcript, event);
  const cursor = readState(dir).items[name]?.lastTurn ?? 0;
  const to = toTurn ?? turns;
  const from = fromTurn ?? (item.context === 'session' ? 0 : Math.min(cursor, to));
  if (from < 0 || to < from || to > turns) throw new Error(`invalid turn range ${from}..${to} (session has ${turns} turns)`);
  if (!dryRun) {
    const metadata = ensureSessionMetadata({ root, event, sessionContext });
    if (metadata.warning) log(dir, metadata.warning);
  }

  const runnerName = resolveRunnerName(item, config);
  const runner = getRunner(runnerName);
  const r = runItem({
    item, runner, transcript, event, config, root, sessionDir: dir, fromTurn: from, toTurn: to, env, now: new Date(), dryRun, sessionContext,
  });
  return { item: name, runner: runnerName, model: r.model, effort: r.effort, fromTurn: from, toTurn: to, ...(dryRun ? { prompt: r.prompt } : { text: r.text, output: r.output }) };
}

export function listItems({ root }) {
  return loadItems(itemsDir(root));
}
