import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateEvent } from '../core/event.js';
import { publishFeedback, validateFeedbackEnvelope } from '../core/feedback.js';
import { applyOutput, cleanTitle, ensureSessionMetadata, expandPathTemplate } from '../core/outputs.js';
import { safeSegment, sessionOutputDir } from '../core/paths.js';
import { fillPrompt, renderContext, resolveEffort, resolveModel, runItem } from '../core/runner.js';
import { getSessionContext, normalizeCreatedAt } from '../core/session.js';
import { emptyState, planEvent } from '../core/scheduler.js';
import {
  buildIdlePromptEnvelope,
  completeIdlePrompt,
  createIdleRoute,
  markIdlePromptScheduled,
  markIdlePromptScheduleFailed,
  markIdlePromptTriggered,
  planIdlePrompt,
  publishIdlePromptPlan,
} from '../core/idle-prompt.js';
import { readState, runIsStale, updateState, updateStateAsync, withLock } from '../core/state.js';
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
  assert.equal(r.state.items.a.lastTurn, 0);
  assert.equal(r.state.items.a.scheduledThrough, 2);
  assert.equal(r.state.items.a.completedThrough, 0);
  assert.deepEqual(r.state.items.a.running, { job: 'j1', since: '2026-10-09T00:00:00.000Z' });

  // A successful worker advances the completion cursor; the same turn then stays idempotent.
  r.state.items.a.completedThrough = 2;
  r.state.items.a.lastTurn = 2;
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
  assert.equal(busy.state.items.b.scheduledThrough, 3);
  assert.equal(busy.state.items.b.completedThrough, 2);

  const stale = plan([item('a', 1)], state, 3, () => true);
  assert.deepEqual(stale.due, [{ name: 'a', fromTurn: 2, toTurn: 3 }]);
});

test('scheduler: a shorter branch restarts counting', () => {
  const r = plan([item('a', 2)], { v: 1, items: { a: { lastTurn: 6 } } }, 3);
  assert.deepEqual(r.due, []);
  assert.equal(r.state.items.a.lastTurn, 3);
});

test('generic idle prompt: schedules, wakes, completes, and keeps the prompt opaque', () => {
  const route = createIdleRoute('s', { instanceId: 'instance-idle', replySubject: '_INBOX.idle' });
  const config = { idle: { enabled: true, after: '1m', afterMs: 60_000, prompt: 'Reply IDLE_OK' } };
  const event = { agent: 'pi', session: 's', activity: 'work', turn: 1, progressId: 'user-1', idleRoute: route };
  const first = planIdlePrompt({ state: emptyState(), event, config, now: '2026-10-12T12:00:00.000Z', planId: 'idle-1' });
  assert.equal(first.action.type, 'schedule');
  assert.equal(first.action.plan.prompt, 'Reply IDLE_OK');
  assert.notEqual(first.action.plan.route.scheduleSubject, route.scheduleSubject);
  const scheduled = markIdlePromptScheduled(first.state, 'idle-1');
  const triggered = markIdlePromptTriggered(scheduled, { idlePromptId: 'idle-1' });
  const completed = completeIdlePrompt(triggered.state, { idlePromptId: 'idle-1' });
  assert.equal(completed.matched, true);
  assert.equal(completed.state.idle.plan, null);
  assert.equal(completed.state.idle.lastCheck.documentWritten, null);
  const envelope = buildIdlePromptEnvelope({ event, plan: first.action.plan, prompt: first.action.plan.prompt });
  assert.equal(envelope.envelope.type, 'idle-prompt');
  assert.equal(envelope.envelope.prompt, 'Reply IDLE_OK');
});

test('generic idle prompt: replacement keeps its cancellation target', () => {
  const route = createIdleRoute('s', { instanceId: 'instance-a', replySubject: '_INBOX.idle-a' });
  const config = { idle: { enabled: true, afterMs: 60_000, prompt: 'Reply IDLE_OK' } };
  const firstEvent = { agent: 'pi', session: 's', activity: 'work', turn: 1, progressId: 'user-1', idleRoute: route };
  const first = planIdlePrompt({ state: emptyState(), event: firstEvent, config, planId: 'idle-1' });
  const scheduled = markIdlePromptScheduled(first.state, 'idle-1');
  const second = planIdlePrompt({
    state: scheduled,
    event: { ...firstEvent, turn: 2, progressId: 'user-2' },
    config,
    planId: 'idle-2',
  });
  assert.equal(second.action.previousPlan.id, 'idle-1');
  assert.deepEqual(second.action.plan.previousPlan, { id: 'idle-1', route: first.action.plan.route });

  const newRoute = createIdleRoute('s', { instanceId: 'instance-b', replySubject: '_INBOX.idle-b' });
  const restarted = planIdlePrompt({
    state: scheduled,
    event: { ...firstEvent, idleRoute: newRoute },
    config,
    planId: 'idle-after-restart',
  });
  assert.equal(restarted.action.plan.id, 'idle-after-restart');
  assert.equal(restarted.action.previousPlan.id, 'idle-1');
  assert.equal(restarted.action.plan.route.instanceId, 'instance-b');
});

test('generic idle prompt: publisher cancels before replacement', async () => {
  const route = createIdleRoute('s', { instanceId: 'instance-a', replySubject: '_INBOX.idle-a' });
  const previous = { id: 'idle-1', route: { ...route, scheduleSubject: `${route.scheduleSubject}.plan.idle-1` } };
  const idlePlan = {
    id: 'idle-2',
    work: { turn: 2, progressId: 'user-2' },
    deadline: '2026-10-12T12:01:00.000Z',
    prompt: 'Reply IDLE_OK',
    route: { ...route, scheduleSubject: `${route.scheduleSubject}.plan.idle-2` },
  };
  const event = { agent: 'pi', session: 's', turn: 2, idleRoute: route };
  const calls = [];
  let closed = 0;
  const manager = {
    streams: {
      async info() {
        return { config: { subjects: ['agent-sidecar.handoff.>'], allow_msg_schedules: true, allow_rollup_hdrs: true } };
      },
    },
  };
  const result = await publishIdlePromptPlan({
    config: { feedback: { natsUrl: 'nats://127.0.0.1:4222' } },
    event,
    plan: idlePlan,
    previousPlan: previous,
    manager: async () => manager,
    jsFactory: () => ({
      publish(subject, payload, options) {
        calls.push({ subject, payload, options });
        return Promise.resolve({});
      },
    }),
    connect: async () => ({
      async close() { closed += 1; },
    }),
  });
  assert.deepEqual(result, { scheduled: true, warning: null });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].subject, route.controlSubject);
  assert.equal(calls[0].options.headers.get('Nats-Scheduler'), previous.route.scheduleSubject);
  assert.equal(calls[1].subject, idlePlan.route.scheduleSubject);
  assert.notEqual(calls[1].subject, calls[0].options.headers.get('Nats-Scheduler'));
  assert.equal(calls[1].options.msgID, 'agent-sidecar-idle-idle-2');
  assert.equal(closed, 1);
});

test('generic idle prompt: uncertain publish retries the same plan id', async () => {
  const route = createIdleRoute('s', { instanceId: 'instance-timeout', replySubject: '_INBOX.timeout' });
  const event = { agent: 'pi', session: 's', activity: 'work', turn: 1, progressId: 'user-1', idleRoute: route };
  const config = { idle: { enabled: true, afterMs: 60_000, prompt: 'Reply IDLE_OK' } };
  const first = planIdlePrompt({ state: emptyState(), event, config, planId: 'idle-timeout' });
  const manager = {
    streams: {
      async info() {
        return { config: { subjects: ['agent-sidecar.handoff.>'], allow_msg_schedules: true, allow_rollup_hdrs: true } };
      },
    },
  };
  const result = await publishIdlePromptPlan({
    config: { feedback: { natsUrl: 'nats://127.0.0.1:4222' } },
    event,
    plan: first.action.plan,
    previousPlan: null,
    manager: async () => manager,
    jsFactory: () => ({ publish: () => new Promise(() => {}) }),
    connect: async () => ({ async close() {} }),
    timeoutMs: 10,
  });
  assert.equal(result.scheduled, false);
  assert.match(result.warning, /schedule timed out/);
  const pending = markIdlePromptScheduleFailed(first.state, 'idle-timeout', result.warning);
  assert.equal(pending.idle.plan.status, 'pending');
  assert.equal(pending.idle.plan.id, 'idle-timeout');
  assert.equal(pending.idle.plan.scheduleAttempts, 1);
  assert.equal(planIdlePrompt({ state: pending, event, config, planId: 'must-not-replace' }).action.plan.id, 'idle-timeout');
});

test('generic idle prompt: lifecycle is idempotent and reorder-safe', () => {
  const route = createIdleRoute('s', { instanceId: 'instance-lifecycle', replySubject: '_INBOX.lifecycle' });
  const config = { idle: { enabled: true, afterMs: 60_000, prompt: 'Reply IDLE_OK' } };
  const event = { agent: 'pi', session: 's', activity: 'work', turn: 1, progressId: 'user-1', idleRoute: route };
  const first = planIdlePrompt({ state: emptyState(), event, config, planId: 'idle-1' });
  const completedBeforeTrigger = completeIdlePrompt(first.state, { idlePromptId: 'idle-1' });
  assert.equal(completedBeforeTrigger.matched, true);
  assert.equal(markIdlePromptTriggered(completedBeforeTrigger.state, { idlePromptId: 'idle-1' }).matched, false);

  const second = planIdlePrompt({
    state: completedBeforeTrigger.state,
    event: { ...event, turn: 2, progressId: 'user-2' },
    config,
    planId: 'idle-2',
  });
  const triggered = markIdlePromptTriggered(second.state, { idlePromptId: 'idle-2' });
  const duplicateTrigger = markIdlePromptTriggered(triggered.state, { idlePromptId: 'idle-2' });
  assert.equal(duplicateTrigger.matched, true);
  assert.equal(duplicateTrigger.state.idle.plan.triggeredAt, triggered.state.idle.plan.triggeredAt);

  const replacement = planIdlePrompt({
    state: duplicateTrigger.state,
    event: { ...event, turn: 3, progressId: 'user-3' },
    config,
    planId: 'idle-3',
  });
  assert.equal(completeIdlePrompt(replacement.state, { idlePromptId: 'idle-3' }).matched, false);
  const completed = completeIdlePrompt(replacement.state, { idlePromptId: 'idle-2' });
  assert.equal(completed.matched, true);
  assert.equal(completed.state.idle.plan.id, 'idle-3');
});

test('generic idle prompt: disabled sessions do not create idle state', () => {
  const state = { v: 1, items: {} };
  const config = { idle: { enabled: false, afterMs: 60_000, prompt: 'x' } };
  const result = planIdlePrompt({ state, event: { agent: 'pi', session: 's', turn: 1 }, config });
  assert.equal(result.state.idle, undefined);
  assert.equal(result.action, null);
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
  assert.equal(renderTranscript(messages, { maxChars: 10000, toolResultLines: 2, include: ['user', 'assistant'] }), '[user]\none\n\n[assistant]\nok\n\n[user]\ntwo\n\n[assistant]\ndone');

  const cut = renderTranscript(messages, { maxChars: 50, toolResultLines: 2 });
  assert.ok(cut.length <= 50);
  assert.ok(cut.startsWith('[… earlier context truncated]'));
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

test('feedback and idle routes are optional and validated against the session', () => {
  const route = { v: 1, instanceId: 'instance-a', replySubject: '_INBOX.route-a', session: 's' };
  assert.deepEqual(validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', feedbackRoute: route }, ['pi']).feedbackRoute, route);
  assert.throws(() => validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', feedbackRoute: { ...route, session: 'other' } }, ['pi']), /match event.session/);
  assert.throws(() => validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', feedbackRoute: { ...route, replySubject: '_INBOX.*' } }, ['pi']), /concrete NATS subject/);

  const idleRoute = createIdleRoute('s', { instanceId: 'instance-idle-event', replySubject: '_INBOX.idle-event' });
  const idleEvent = validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', activity: 'idle-prompt', idlePromptId: 'idle-1', idleRoute }, ['pi']);
  assert.deepEqual(idleEvent.idleRoute, idleRoute);
  assert.equal(idleEvent.idlePromptId, 'idle-1');
  assert.throws(() => validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', activity: 'idle-prompt' }, ['pi']), /idlePromptId/);
  assert.throws(() => validateEvent({ v: 1, agent: 'pi', session: 's', transcriptRef: '/f', idleRoute: { ...idleRoute, targetSubject: 'agent.>' } }, ['pi']), /concrete NATS subject/);
});

test('feedback envelope is bounded and publisher flushes through the injected NATS client', async () => {
  const route = { v: 1, instanceId: 'instance-a', replySubject: '_INBOX.route-a', session: 's' };
  const event = { agent: 'pi', session: 's', turn: 4, feedbackRoute: route };
  const item = { name: 'review', feedback: true };
  const published = [];
  let flushed = 0;
  let closed = 0;
  const result = await publishFeedback({
    item,
    event,
    content: 'Use the documented API.',
    sourceTurn: 4,
    config: { feedback: { natsUrl: 'nats://user:pass@127.0.0.1:14222' } },
    now: new Date('2026-10-11T09:00:00.000Z'),
    connect: async (options) => {
      assert.equal(options.servers, 'nats://127.0.0.1:14222');
      assert.equal(options.user, 'user');
      assert.equal(options.pass, 'pass');
      return {
        publish(subject, payload) { published.push({ subject, payload: new TextDecoder().decode(payload) }); },
        async flush() { flushed += 1; },
        async close() { closed += 1; },
      };
    },
  });
  assert.equal(result.published, true);
  assert.equal(published[0].subject, route.replySubject);
  const envelope = JSON.parse(published[0].payload);
  assert.deepEqual(validateFeedbackEnvelope(envelope), envelope);
  assert.equal(envelope.item, 'review');
  assert.equal(envelope.sourceTurn, 4);
  assert.equal(envelope.content, 'Use the documented API.');
  const longEnvelope = validateFeedbackEnvelope({ ...envelope, content: 'x'.repeat(1024) });
  assert.equal(longEnvelope.content.length, 1024);
  assert.throws(() => validateFeedbackEnvelope({ ...envelope, content: 'x'.repeat(4097) }), /too large/);
  assert.equal(flushed, 1);
  assert.equal(closed, 1);

  const skipped = await publishFeedback({ item, event, content: '   ', config: { feedback: { natsUrl: 'nats://127.0.0.1:4222' } }, connect: async () => { throw new Error('must not connect'); } });
  assert.deepEqual(skipped, { published: false, warning: null });
});

test('feedback transport failures return warnings without failing the item', async () => {
  const result = await publishFeedback({
    item: { name: 'review', feedback: true },
    event: { agent: 'pi', session: 's', turn: 1, feedbackRoute: { v: 1, instanceId: 'i', replySubject: '_INBOX.x', session: 's' } },
    content: 'Finding',
    config: { feedback: { natsUrl: 'nats://127.0.0.1:4222' } },
    connect: async () => { throw new Error('broker unavailable'); },
  });
  assert.equal(result.published, false);
  assert.match(result.warning, /feedback publish failed: broker unavailable/);
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

test('context recent scope, role filtering and previous files are rendered within one budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-'));
  const previous = path.join(dir, 'summary.md');
  fs.writeFileSync(previous, 'Previous snapshot');
  const result = runItem({
    item: {
      name: 'summary',
      dir,
      kind: 'prompt',
      prompt: 'Summarize\n{{transcript}}',
      context: 'recent',
      contextSpec: { scope: 'recent', turns: 1, include: ['user', 'assistant'], maxChars: 1000, files: ['summary.md'] },
      output: { type: 'none' },
    },
    runner: { name: 'fake', callModel: ({ prompt }) => prompt },
    transcript: { cwd: '/work/demo', messages: [
      { role: 'user', text: 'old request' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'new request' },
      { role: 'assistant', text: 'new answer' },
    ] },
    event: { agent: 'pi', session: 's', model: 'session/model', pane: null },
    config: { model: null, timeoutMs: 42, maxTranscriptChars: 1000, toolResultLines: 20 },
    root: dir,
    sessionDir: path.join(dir, 'state'),
    fromTurn: 0,
    toTurn: 2,
    env: { HOME: dir },
    now: new Date(),
  });
  assert.match(result.text, /\[file summary\.md\]\nPrevious snapshot/);
  assert.doesNotMatch(result.text, /old request/);
  assert.match(result.text, /new request/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('context files keep priority when files and transcript exceed the total budget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'summary.md'), 'Previous snapshot');
  const item = {
    name: 'summary',
    dir,
    contextSpec: { scope: 'delta', turns: null, include: ['user', 'assistant'], maxChars: 100, files: ['summary.md'] },
  };
  const rendered = renderContext(item, [
    { role: 'user', text: 'new request' },
    { role: 'assistant', text: 'new answer '.repeat(100) },
  ], {
    root: dir,
    event: { agent: 'pi', session: 's' },
    now: new Date(),
    env: { HOME: dir },
    fromTurn: 0,
    toTurn: 1,
    config: { maxTranscriptChars: 1000, toolResultLines: 20 },
  });
  assert.ok(rendered.length <= 100);
  assert.match(rendered, /\[file summary\.md\]\nPrevious snapshot/);
  assert.match(rendered, /\[assistant\]/);

  fs.writeFileSync(path.join(dir, 'summary.md'), 'Previous snapshot '.repeat(100));
  const oversizedFile = renderContext(item, [], {
    root: dir,
    event: { agent: 'pi', session: 's' },
    now: new Date(),
    env: { HOME: dir },
    fromTurn: 0,
    toTurn: 1,
    config: { maxTranscriptChars: 1000, toolResultLines: 20 },
  });
  assert.ok(oversizedFile.length <= 100);
  assert.match(oversizedFile, /^\[file summary\.md\]/);
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

test('session context normalizes creation time and derives a stable UTC month', () => {
  assert.equal(normalizeCreatedAt('2026-10-31T23:30:00.000Z'), '2026-10-31T23:30:00.000Z');
  assert.equal(normalizeCreatedAt('2026-10-31T23:30:00-04:00'), '2026-11-01T03:30:00.000Z');
  assert.throws(() => normalizeCreatedAt('2026-02-30T00:00:00Z'), /valid date-time/);
  assert.throws(() => normalizeCreatedAt('2026-10-31'), /RFC 3339/);

  const context = getSessionContext(
    { createdAt: '2026-10-31T23:30:00.000Z' },
    { agent: 'pi', session: 'a/b' },
  );
  assert.deepEqual(context, {
    agent: 'pi',
    sessionId: 'a/b',
    createdAt: '2026-10-31T23:30:00.000Z',
    sessionMonth: '2026-10',
    createdAtError: null,
  });
  assert.equal(sessionOutputDir('/r', 'pi', context.sessionMonth, 'a/b'), '/r/out/pi/2026-10/a_b');
});

test('sessionMonth paths fail visibly without creation metadata', () => {
  const base = { root: '/r', env: { HOME: '/h' }, now: new Date('2026-10-09T00:00:00Z'), item: { name: 'sum' }, event: { agent: 'pi', session: 's' } };
  assert.equal(
    expandPathTemplate('out/{agent}/{sessionMonth}/{session}.md', { ...base, sessionContext: { sessionMonth: '2026-10' } }),
    '/r/out/pi/2026-10/s.md',
  );
  assert.throws(
    () => expandPathTemplate('out/{agent}/{sessionMonth}/{session}.md', { ...base, sessionContext: { createdAtError: 'missing timestamp' } }),
    /sessionMonth unavailable: missing timestamp/,
  );
});

test('session metadata is created once in the canonical month directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const event = { agent: 'pi', session: 'a/b' };
  const sessionContext = { createdAt: '2026-10-31T23:30:00.000Z', sessionMonth: '2026-10', createdAtError: null };
  const first = ensureSessionMetadata({ root, event, sessionContext });
  assert.equal(first.written, path.join(root, 'out', 'pi', '2026-10', 'a_b', 'metadata.json'));
  assert.equal(first.warning, null);
  const file = first.written;
  const original = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(original), { sessionId: 'a/b', agent: 'pi', createdAt: sessionContext.createdAt });

  const existing = `${JSON.stringify({ ...JSON.parse(original), keep: true })}\n`;
  fs.writeFileSync(file, existing);
  const second = ensureSessionMetadata({ root, event, sessionContext });
  assert.equal(second.written, file);
  assert.equal(fs.readFileSync(file, 'utf8'), existing);

  fs.writeFileSync(file, '{}\n');
  assert.throws(() => ensureSessionMetadata({ root, event, sessionContext }), /does not match the current session/);
});

test('session metadata creation is safe when two workers race', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleRoot = path.resolve(import.meta.dirname, '..');
  const code = `import { ensureSessionMetadata } from './core/outputs.js';
const result = ensureSessionMetadata({
  root: ${JSON.stringify(root)},
  event: { agent: 'pi', session: 'race/session' },
  sessionContext: { createdAt: '2026-10-10T13:35:00.000Z', sessionMonth: '2026-10', createdAtError: null },
});
console.log(JSON.stringify(result));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: moduleRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.warning, null);
  assert.equal(second.warning, null);
  const file = path.join(root, 'out', 'pi', '2026-10', 'race_session', 'metadata.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    sessionId: 'race/session',
    agent: 'pi',
    createdAt: '2026-10-10T13:35:00.000Z',
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['metadata.json']);
});

test('outputs: replace mode atomically replaces a file while append remains a log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-'));
  const ctx = { root: dir, env: { HOME: dir }, now: new Date('2026-10-09T00:00:00Z'), item: { name: 'summary' }, event: { agent: 'pi', session: 's' }, fromTurn: 0, toTurn: 2 };
  const output = { type: 'file', path: 'out/summary.md', mode: 'replace' };
  assert.equal(applyOutput(output, 'first snapshot', ctx).written, path.join(dir, 'out/summary.md'));
  assert.equal(fs.readFileSync(path.join(dir, 'out/summary.md'), 'utf8'), 'first snapshot\n');
  applyOutput(output, 'second snapshot', ctx);
  assert.equal(fs.readFileSync(path.join(dir, 'out/summary.md'), 'utf8'), 'second snapshot\n');
  applyOutput({ ...output, mode: 'append' }, 'activity', ctx);
  assert.match(fs.readFileSync(path.join(dir, 'out/summary.md'), 'utf8'), /second snapshot\n## .*summary.*\n\nactivity/);
  fs.rmSync(dir, { recursive: true, force: true });
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
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'lock'), old, old);
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

test('state: async lock stays exclusive across an awaited publication', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-async-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const order = [];
  const first = updateStateAsync(dir, async (state) => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('first-end');
    return { state: { ...state, first: true } };
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  const second = updateStateAsync(dir, async (state) => {
    order.push('second-start');
    return { state: { ...state, second: true } };
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  assert.deepEqual(readState(dir), { v: 1, items: {}, first: true, second: true });
});

test('state: run staleness', () => {
  const now = Date.parse('2026-10-09T01:00:00Z');
  assert.equal(runIsStale({ since: '2026-10-09T00:59:00Z', pid: process.pid }, now), false);
  assert.equal(runIsStale({ since: '2026-10-09T00:59:00Z', pid: 999999999 }, now), true);
  assert.equal(runIsStale({ since: '2026-10-09T00:00:00Z' }, now), true);
});
