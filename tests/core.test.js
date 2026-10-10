import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateEvent } from '../core/event.js';
import { cleanTitle, expandPathTemplate } from '../core/outputs.js';
import { safeSegment } from '../core/paths.js';
import { fillPrompt, resolveEffort, resolveModel, runItem } from '../core/runner.js';
import { emptyState, planEvent } from '../core/scheduler.js';
import { readState, runIsStale, updateState, withLock } from '../core/state.js';
import { countTurns, renderTranscript, sliceTurns } from '../core/transcript.js';
import { DEFAULT_RUNNER, getRunner, resolveRunnerName } from '../runners/index.js';
import { buildJcodeArgs, normalizeJcodeModel } from '../runners/jcode.js';

const item = (name, everyTurns, context = 'delta') => ({ name, everyTurns, context });
const plan = (items, state, turn, isStale = () => false) =>
  planEvent({ items, state, turn, job: 'j1', now: '2026-10-09T00:00:00.000Z', isStale });

test('scheduler: an item is due once everyTurns turns passed since its last run', () => {
  let r = plan([item('a', 2)], emptyState(), 1);
  assert.deepEqual(r.due, []);
  assert.deepEqual(r.skipped, [{ name: 'a', reason: 'not_due' }]);

  r = plan([item('a', 2)], r.state, 2);
  assert.deepEqual(r.due, [{ name: 'a', fromTurn: 0, toTurn: 2 }]);
  assert.equal(r.state.items.a.lastTurn, 2);
  assert.deepEqual(r.state.items.a.running, { job: 'j1', since: '2026-10-09T00:00:00.000Z' });

  // The same turn reported twice does not run it twice.
  delete r.state.items.a.running;
  assert.deepEqual(plan([item('a', 2)], r.state, 2).due, []);
  assert.deepEqual(plan([item('a', 2)], r.state, 4).due, [{ name: 'a', fromTurn: 2, toTurn: 4 }]);
});

test('scheduler: running items are skipped unless stale; session context starts at 0', () => {
  const state = { v: 1, items: { a: { lastTurn: 2, running: { job: 'old', since: 'x' } }, b: { lastTurn: 2 } } };
  const busy = plan([item('a', 1), item('b', 1, 'session')], state, 3);
  assert.deepEqual(busy.skipped, [{ name: 'a', reason: 'running' }]);
  assert.deepEqual(busy.due, [{ name: 'b', fromTurn: 0, toTurn: 3 }]);
  assert.equal(busy.state.items.a.lastTurn, 2, 'skipped item keeps its cursor');
  assert.equal(state.items.b.lastTurn, 2, 'input state is not mutated');

  const stale = plan([item('a', 1)], state, 3, () => true);
  assert.deepEqual(stale.due, [{ name: 'a', fromTurn: 2, toTurn: 3 }]);
});

test('scheduler: a shorter branch restarts counting', () => {
  const r = plan([item('a', 2)], { v: 1, items: { a: { lastTurn: 6 } } }, 3);
  assert.deepEqual(r.due, []);
  assert.equal(r.state.items.a.lastTurn, 3);
});

test('transcript: turns, slicing and rendering', () => {
  const messages = [
    { role: 'user', text: 'one' },
    { role: 'assistant', text: 'ok' },
    { role: 'tool', name: 'bash', text: 'l1\nl2\nl3\nl4' },
    { role: 'user', text: 'two' },
    { role: 'assistant', text: 'done' },
  ];
  assert.equal(countTurns(messages), 2);
  assert.deepEqual(sliceTurns(messages, 1, 2).map((m) => m.text), ['two', 'done']);
  assert.deepEqual(sliceTurns(messages, 0, 1).length, 3);

  const text = renderTranscript(messages, { maxChars: 10000, toolResultLines: 2 });
  assert.equal(text, '[user]\none\n\n[assistant]\nok\n\n[tool bash]\nl1\nl2\n… [2 more lines]\n\n[user]\ntwo\n\n[assistant]\ndone');

  const cut = renderTranscript(messages, { maxChars: 50, toolResultLines: 2 });
  assert.equal(cut.length, 50);
  assert.ok(cut.startsWith('[… earlier transcript truncated]'));
  assert.ok(cut.endsWith('done'));
});

test('event validation', () => {
  const ok = { v: 1, agent: 'pi', session: 's', transcriptRef: '/f' };
  assert.deepEqual(validateEvent(ok, ['pi']), { ...ok, model: null, pane: null, turn: null });
  assert.throws(() => validateEvent({ ...ok, v: 2 }, ['pi']), /version/);
  assert.throws(() => validateEvent({ ...ok, agent: 'codex' }, ['pi']), /unknown agent/);
  assert.throws(() => validateEvent({ ...ok, session: '' }, ['pi']), /session/);
  assert.throws(() => validateEvent({ ...ok, turn: -1 }, ['pi']), /turn/);
  assert.throws(() => validateEvent({ ...ok, model: 3 }, ['pi']), /model/);
});

test('model priority: item, then global, then session', () => {
  const event = { model: 'session/m' };
  assert.equal(resolveModel({ model: 'item/m' }, { model: 'global/m' }, event), 'item/m');
  assert.equal(resolveModel({ model: null }, { model: 'global/m' }, event), 'global/m');
  assert.equal(resolveModel({ model: null }, { model: null }, event), 'session/m');
  assert.equal(resolveModel({ model: null }, { model: null }, { model: null }), null);
});

test('runner selection: item, then global, then Pi default', () => {
  assert.equal(resolveRunnerName({ runner: 'claude' }, { runner: 'pi' }), 'claude');
  assert.equal(resolveRunnerName({ runner: null }, { runner: 'pi' }), 'pi');
  assert.equal(resolveRunnerName({ runner: null }, { runner: null }), DEFAULT_RUNNER);
  assert.equal(getRunner('pi').name, 'pi');
  assert.equal(getRunner('jcode').name, 'jcode');
  assert.throws(() => getRunner('claude'), /unknown runner/);
});

test('jcode runner: normalizes Pi model names and supports provider profiles', () => {
  assert.deepEqual(normalizeJcodeModel('openai-codex/gpt-5.6-luna:xhigh'), {
    model: 'gpt-5.6-luna',
    provider: 'openai',
    providerProfile: null,
  });
  assert.deepEqual(normalizeJcodeModel('gemini-3.8-flash-high'), {
    model: 'gemini-3.8-flash-high',
    provider: null,
    providerProfile: null,
  });
  assert.deepEqual(normalizeJcodeModel('cpa/gemini-3.8-flash-high', { providerProfile: 'cpa-gemini-3-8' }), {
    model: 'gemini-3.8-flash-high',
    provider: null,
    providerProfile: 'cpa-gemini-3-8',
  });
  const args = buildJcodeArgs({ model: 'openai-codex/gpt-5.6-luna', env: {} });
  assert.deepEqual(args.slice(0, 7), ['run', '--json', '--quiet', '--no-update', '--no-selfdev', '--tool-profile', 'none']);
  assert.deepEqual(args.slice(-4), ['--provider', 'openai', '--model', 'gpt-5.6-luna']);
});

test('effort selection: item overrides global and defaults to null', () => {
  assert.equal(resolveEffort({ effort: 'low' }, { effort: 'high' }), 'low');
  assert.equal(resolveEffort({ effort: null }, { effort: 'high' }), 'high');
  assert.equal(resolveEffort({ effort: null }, { effort: null }), null);
});

test('prompt execution delegates model work to the injected runner', () => {
  const calls = [];
  const result = runItem({
    item: { name: 'summary', kind: 'prompt', prompt: 'Summarize', output: { type: 'none' } },
    runner: {
      name: 'fake',
      callModel(args) {
        calls.push(args);
        return 'done';
      },
    },
    transcript: { cwd: '/work/demo', messages: [{ role: 'user', text: 'hello' }] },
    event: { agent: 'pi', session: 's', model: 'session/model', pane: null },
    config: { model: null, timeoutMs: 42, maxTranscriptChars: 1000, toolResultLines: 20 },
    root: '/tmp',
    sessionDir: '/tmp/session',
    fromTurn: 0,
    toTurn: 1,
    env: process.env,
    now: new Date(),
  });
  assert.equal(result.text, 'done');
  assert.equal(calls[0].model, 'session/model');
  assert.equal(calls[0].effort, null);
  assert.equal(calls[0].timeoutMs, 42);
  assert.match(calls[0].prompt, /hello/);
});

test('prompt filling appends the transcript when the prompt does not place it', () => {
  assert.equal(fillPrompt('T {{toTurn}} {{transcript}} {{nope}}', { transcript: 'X', toTurn: 3 }), 'T 3 X {{nope}}');
  assert.equal(fillPrompt('Sum up', { transcript: 'X' }), 'Sum up\n\n<transcript>\nX\n</transcript>');
});

test('outputs: title cleaning and path templates', () => {
  assert.equal(cleanTitle('\n  "# Fix login bug"  \nmore'), 'Fix login bug');
  assert.equal(cleanTitle('x'.repeat(100)).length, 80);
  const ctx = { root: '/r', env: { HOME: '/h' }, now: new Date(2026, 9, 9), item: { name: 'sum' }, event: { agent: 'pi', session: 'a/b' } };
  assert.equal(expandPathTemplate('out/{agent}/{session}/{item}-{date}.md', ctx), '/r/out/pi/a_b/sum-2026-10-09.md');
  assert.equal(expandPathTemplate('~/notes/{date}.md', ctx), '/h/notes/2026-10-09.md');
  assert.throws(() => expandPathTemplate('{cwd}.md', ctx), /unknown placeholder/);
  assert.equal(safeSegment('..'), '_..');
});

test('state: lock excludes a second process and recovers from a dead holder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Another process holds the lock for a while; our updateState must wait for it.
  const stateUrl = new URL('../core/state.js', import.meta.url).href;
  const holder = spawn(
    process.execPath,
    ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(stateUrl)}; withLock(${JSON.stringify(dir)}, () => { console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); });`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const started = Date.now();
  updateState(dir, (state) => ({ state: { ...state, items: { a: { lastTurn: 1 } } } }));
  assert.ok(Date.now() - started >= 200, 'waited for the other holder');
  await new Promise((resolve) => holder.on('exit', resolve));
  assert.equal(readState(dir).items.a.lastTurn, 1);

  // A lock left behind by a dead process is taken over.
  fs.writeFileSync(path.join(dir, 'lock'), '999999999');
  assert.equal(withLock(dir, () => 'got it'), 'got it');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('state: run staleness', () => {
  const now = Date.parse('2026-10-09T01:00:00Z');
  assert.equal(runIsStale({ since: '2026-10-09T00:59:00Z', pid: process.pid }, now), false);
  assert.equal(runIsStale({ since: '2026-10-09T00:59:00Z', pid: 999999999 }, now), true);
  assert.equal(runIsStale({ since: '2026-10-09T00:00:00Z' }, now), true);
});
