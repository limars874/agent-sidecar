// The CLI host: every command is one short-lived process. State between
// events lives only in the session's state directory.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { loadConfig } from '../core/config.js';
import { validateEvent } from '../core/event.js';
import { loadItems } from '../core/items.js';
import { BIN_PATH, itemsDir, sessionDir } from '../core/paths.js';
import { runItem } from '../core/runner.js';
import { planEvent } from '../core/scheduler.js';
import { appendLine, readState, runIsStale, updateState, writeJsonAtomic } from '../core/state.js';
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

// `agent-sidecar event`: decide what is due, record it, hand it to a detached worker.
export function handleEvent(rawEvent, { root, env, foreground = false }) {
  const event = validateEvent(rawEvent, Object.keys(ADAPTERS));
  const adapter = getAdapter(event.agent);
  const dir = sessionDir(root, event.agent, event.session);
  const items = loadItemsLogged(root, dir);
  const turn = event.turn ?? countTurns(adapter.readTranscript(event.transcriptRef).messages);

  const job = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const { due, skipped } = updateState(dir, (state) =>
    planEvent({ items, state, turn, job, now: new Date().toISOString(), isStale: (r) => runIsStale(r) }),
  );
  if (due.length === 0) return { job: null, turn, scheduled: [], skipped };

  const jobFile = path.join(dir, 'jobs', `${job}.json`);
  writeJsonAtomic(jobFile, { v: 1, id: job, event: { ...event, turn }, items: due });
  log(dir, `job ${job} turn ${turn}: ${due.map((d) => d.name).join(', ')}`);

  if (foreground) {
    work(jobFile, { root, env });
  } else {
    const out = fs.openSync(path.join(dir, LOG_FILE), 'a');
    spawn(process.execPath, [BIN_PATH, 'work', jobFile], { detached: true, stdio: ['ignore', out, out], env }).unref();
    fs.closeSync(out);
  }
  return { job, turn, scheduled: due.map((d) => d.name), skipped };
}

// `agent-sidecar work <job>` (internal): run a job's items one after another.
export function work(jobFile, { root, env }) {
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
  let config, items, transcript, setupError;
  try {
    config = loadConfig(root);
    items = loadItemsLogged(root, dir);
    transcript = getAdapter(event.agent).readTranscript(event.transcriptRef);
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
      const r = runItem({
        item,
        adapter: getAdapter(event.agent),
        transcript,
        event,
        config,
        root,
        sessionDir: dir,
        fromTurn: d.fromTurn,
        toTurn: d.toTurn,
        env,
        now: new Date(),
      });
      Object.assign(record, { status: 'ok', model: r.model, written: r.output.written, warnings: r.output.warnings });
      for (const w of r.output.warnings) log(dir, `${d.name}: ${w}`);
    } catch (err) {
      Object.assign(record, { status: 'error', error: err.message });
      log(dir, `${d.name}: ${err.message}`);
    }
    record.ms = Date.now() - started;
    results.push(record);
    appendLine(path.join(dir, RUNS_FILE), record);
    updateState(dir, (state) => {
      const s = state.items[d.name];
      if (s?.running?.job === job.id) delete s.running;
      if (s) s.lastRun = { at: record.at, status: record.status, fromTurn: d.fromTurn, toTurn: d.toTurn, error: record.error };
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
  const cursor = readState(dir).items[name]?.lastTurn ?? 0;
  const to = toTurn ?? turns;
  const from = fromTurn ?? (item.context === 'session' ? 0 : Math.min(cursor, to));
  if (from < 0 || to < from || to > turns) throw new Error(`invalid turn range ${from}..${to} (session has ${turns} turns)`);

  const r = runItem({
    item, adapter, transcript, event, config, root, sessionDir: dir, fromTurn: from, toTurn: to, env, now: new Date(), dryRun,
  });
  return { item: name, model: r.model, fromTurn: from, toTurn: to, ...(dryRun ? { prompt: r.prompt } : { text: r.text, output: r.output }) };
}

export function listItems({ root }) {
  return loadItems(itemsDir(root));
}
