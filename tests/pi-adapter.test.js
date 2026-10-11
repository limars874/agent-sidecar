import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildEvent, createExtension } from '../adapters/pi/extension.js';
import { callPiModel, PI_ARGS, preparePiModel } from '../runners/pi.js';
import { readPiSession, readPiSessionInfo } from '../adapters/pi/transcript.js';
import { countTurns } from '../core/transcript.js';
import { PI_SESSION, PI_SESSION_ID, readJsonLines, sandbox, waitFor } from './helpers.js';

test('Pi session: active branch only, roles mapped, partial last line ignored', () => {
  const t = readPiSession(PI_SESSION);
  assert.equal(t.session, PI_SESSION_ID);
  assert.equal(t.cwd, '/work/demo');
  assert.equal(t.model, 'anthropic/m', 'latest assistant reply on the branch');
  assert.equal(t.createdAt, '2026-10-09T10:00:00.000Z');
  assert.equal(t.createdAtError, null);
  assert.deepEqual(t.messages, [
    { role: 'user', text: 'List the files' },
    { role: 'assistant', text: 'Listing.' },
    { role: 'toolCall', name: 'bash', text: '{"command":"ls"}' },
    { role: 'toolResult', name: 'bash', text: 'a.txt\nb.txt' },
    { role: 'assistant', text: 'Two files: a.txt and b.txt.' },
    { role: 'user', text: 'Rename a.txt to c.txt\n[image]' },
    { role: 'toolCall', name: 'bash', text: '{"command":"mv a.txt c.txt"}' },
    { role: 'toolResult', name: 'bash', text: '' },
    { role: 'assistant', text: 'Renamed a.txt to c.txt.' },
  ]);
  assert.equal(countTurns(t.messages), 2);
});

test('Pi session info reads only the header metadata', (t) => {
  const box = sandbox(t);
  const file = path.join(box.dir, 'header-only.jsonl');
  fs.writeFileSync(file, '{"type":"session","version":3,"id":"header-only","timestamp":"2026-10-31T23:30:00.000Z"}\nnot-json\n');
  assert.deepEqual(readPiSessionInfo(file), {
    session: 'header-only',
    createdAt: '2026-10-31T23:30:00.000Z',
    createdAtError: null,
  });
});

test('Pi runner: explicit effort uses --thinking and overrides a model suffix', (t) => {
  const box = sandbox(t);
  assert.deepEqual(preparePiModel({ model: 'anthropic/cheap:low', effort: 'xhigh' }), { model: 'anthropic/cheap', effort: 'xhigh' });
  assert.deepEqual(preparePiModel({ model: 'anthropic/cheap:xhigh', effort: null }), { model: 'anthropic/cheap:xhigh', effort: null });
  callPiModel({ model: 'anthropic/cheap:low', effort: 'xhigh', prompt: 'hello', timeoutMs: 10000, env: { ...box.env, FAKE_PI_REPLY: 'Answer' } });
  const [call] = box.piCalls();
  assert.deepEqual(call.args, [...PI_ARGS, '--model', 'anthropic/cheap', '--thinking', 'xhigh']);
});

test('Pi session: a file without a header is rejected', (t) => {
  const box = sandbox(t);
  const file = path.join(box.dir, 'x.jsonl');
  fs.writeFileSync(file, '{"type":"message","id":"a","parentId":null}\n');
  assert.throws(() => readPiSession(file), /not a Pi session/);
});

test('Pi session: invalid creation time is visible without breaking transcript reading', (t) => {
  const box = sandbox(t);
  const file = path.join(box.dir, 'invalid-time.jsonl');
  fs.writeFileSync(file, '{"type":"session","version":3,"id":"bad-time","timestamp":"not-a-time","cwd":"/tmp"}\n');
  const transcript = readPiSession(file);
  assert.equal(transcript.createdAt, null);
  assert.match(transcript.createdAtError, /RFC 3339/);
  assert.equal(transcript.session, 'bad-time');
});

test('pi -p call: bare child, prompt on stdin, model passed, guard env set', (t) => {
  const box = sandbox(t);
  const out = callPiModel({ model: 'anthropic/cheap', prompt: 'hello', timeoutMs: 10000, env: { ...box.env, FAKE_PI_REPLY: 'Answer' } });
  assert.equal(out, 'Answer');
  const [call] = box.piCalls();
  assert.deepEqual(call.args, [...PI_ARGS, '--model', 'anthropic/cheap']);
  assert.ok(call.args.includes('--no-extensions'));
  assert.equal(call.prompt, 'hello');
  assert.equal(call.child, '1');

  assert.throws(
    () => callPiModel({ model: 'm', prompt: 'x', timeoutMs: 10000, env: { ...box.env, FAKE_PI_EXIT: '3' } }),
    /pi -p exited 3: fake pi failure/,
  );
});

// Minimal stand-ins for Pi's extension API and context.
function fakePi(messages = []) {
  const handlers = {};
  return {
    handlers,
    messages,
    on: (name, fn) => void (handlers[name] = fn),
    sendMessage: (...args) => messages.push(args),
  };
}

function fakeCtx({ file = PI_SESSION, titles = [], sessionId = PI_SESSION_ID } = {}) {
  return {
    hasUI: true,
    isIdle: () => true,
    model: { provider: 'anthropic', id: 'claude-x' },
    ui: { setTitle: (t) => titles.push(t), notify: () => {} },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => sessionId,
      getBranch: () => [
        { type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant' } },
        { type: 'custom' },
        { type: 'message', message: { role: 'user' } },
      ],
    },
  };
}

test('extension: builds the shared event from Pi context', () => {
  assert.deepEqual(buildEvent(fakeCtx(), { HERDR_PANE_ID: 'w1:p2' }), {
    v: 1,
    agent: 'pi',
    session: PI_SESSION_ID,
    transcriptRef: PI_SESSION,
    model: 'anthropic/claude-x',
    pane: 'w1:p2',
    turn: 2,
  });
  assert.equal(buildEvent(fakeCtx({ file: null }), {}), null);
});

test('extension: registers nothing inside the sidecar own pi -p child', () => {
  const pi = fakePi();
  createExtension({ AGENT_SIDECAR_CHILD: '1' })(pi);
  assert.deepEqual(pi.handlers, {});
});

test('extension: agent_settled reaches the CLI host, which runs the item through pi -p', async (t) => {
  const box = sandbox(t);
  box.item('note.yaml', 'everyTurns: 1\nprompt: Summarize\noutput:\n  file: out/{session}.md\n');
  const pi = fakePi();
  createExtension({ ...box.env, FAKE_PI_REPLY: 'did things', AGENT_SIDECAR_NODE: process.execPath })(pi);

  await pi.handlers.agent_settled({ aborted: true }, fakeCtx());
  await pi.handlers.agent_settled({ aborted: false }, fakeCtx());

  const out = path.join(box.root, 'out', `${PI_SESSION_ID}.md`);
  await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('did things'));
  const runs = await waitFor(() => readJsonLines(path.join(box.stateDir(), 'runs.jsonl')).at(0));
  assert.equal(runs.status, 'ok');
  assert.equal(runs.model, 'anthropic/claude-x', 'session model used when nothing else is set');
  assert.equal(box.piCalls().length, 1, 'the aborted run reported nothing');
});

test('extension: routes feedback to the active session and selects idle delivery', async (t) => {
  const box = sandbox(t);
  box.item('review.yaml', 'everyTurns: 1\nfeedback: true\nprompt: Review\noutput: none\n');
  const messages = [];
  const subscriptions = [];
  let nextMessage;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const connection = {
    subscribe(subject) {
      const subscription = {
        subject,
        unsubscribe() { nextMessage?.({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
        next() { return new Promise((resolve) => { nextMessage = resolve; }); },
      };
      subscriptions.push(subscription);
      return subscription;
    },
    closed: () => closed,
    async close() { resolveClosed(); },
  };
  const route = { v: 1, instanceId: 'instance-a', replySubject: '_INBOX.route-a', session: PI_SESSION_ID };
  const pi = fakePi(messages);
  createExtension(box.env, {
    connectNats: async (options) => {
      assert.equal(options.servers, 'nats://127.0.0.1:4222');
      return connection;
    },
    createFeedbackRoute: () => route,
  })(pi);
  const ctx = fakeCtx();
  await pi.handlers.session_start({}, ctx);
  t.after(() => pi.handlers.session_shutdown({}));
  await waitFor(() => subscriptions.length === 1 && typeof nextMessage === 'function');

  nextMessage({ value: { data: Uint8Array.from([0xc3, 0x28]) }, done: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.length, 0);
  await waitFor(() => typeof nextMessage === 'function');
  nextMessage({ value: { data: new Uint8Array(16 * 1024 + 1) }, done: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.length, 0);
  await waitFor(() => typeof nextMessage === 'function');

  nextMessage({ value: { data: new TextEncoder().encode(JSON.stringify({
    v: 1,
    type: 'feedback',
    id: 'message-1',
    instanceId: route.instanceId,
    agent: 'pi',
    session: PI_SESSION_ID,
    item: 'review',
    sourceTurn: 2,
    createdAt: '2026-10-11T09:00:00.000Z',
    content: 'Check the retry path.',
  })) }, done: false });
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0][1].deliverAs, 'nextTurn');
  assert.match(messages[0][0].content, /Check the retry path/);

  ctx.isIdle = () => false;
  await waitFor(() => typeof nextMessage === 'function');
  nextMessage({ value: { data: new TextEncoder().encode(JSON.stringify({
    v: 1,
    type: 'feedback',
    id: 'message-2',
    instanceId: route.instanceId,
    agent: 'pi',
    session: PI_SESSION_ID,
    item: 'review',
    sourceTurn: 3,
    createdAt: '2026-10-11T09:00:01.000Z',
    content: 'Continue without interrupting the current call.',
  })) }, done: false });
  await waitFor(() => messages.length === 2);
  assert.equal(messages[1][1].deliverAs, 'steer');
});

test('extension: preserves the feedback route across distinct Pi hook contexts', async (t) => {
  const box = sandbox(t);
  box.item('review.yaml', 'everyTurns: 1\nfeedback: true\nprompt: Review\noutput: none\n');
  const subscriptions = [];
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const connection = {
    subscribe(subject) {
      const subscription = {
        subject,
        unsubscribe() {},
        [Symbol.asyncIterator]() { return this; },
        next() { return new Promise(() => {}); },
      };
      subscriptions.push(subscription);
      return subscription;
    },
    closed: () => closed,
    async close() { resolveClosed(); },
  };
  const emitted = [];
  const route = { v: 1, instanceId: 'instance-b', replySubject: '_INBOX.route-b', session: PI_SESSION_ID };
  const pi = fakePi();
  createExtension(box.env, {
    connectNats: async () => connection,
    createFeedbackRoute: () => route,
    spawn: (_command, args) => {
      emitted.push(JSON.parse(args[args.indexOf('--json') + 1]));
      return { on() {}, unref() {} };
    },
  })(pi);
  await pi.handlers.session_start({}, fakeCtx());
  t.after(() => pi.handlers.session_shutdown({}));
  await waitFor(() => subscriptions.length === 1);
  await pi.handlers.agent_settled({ aborted: false }, fakeCtx());
  assert.deepEqual(emitted[0].feedbackRoute, route);
});

test('extension: drops feedback from the previous session after a switch', async (t) => {
  const box = sandbox(t);
  box.item('review.yaml', 'everyTurns: 1\nfeedback: true\nprompt: Review\noutput: none\n');
  const messages = [];
  const connections = [];
  const routes = [
    { v: 1, instanceId: 'instance-old', replySubject: '_INBOX.old', session: 'session-old' },
    { v: 1, instanceId: 'instance-new', replySubject: '_INBOX.new', session: 'session-new' },
  ];
  const makeConnection = () => {
    let resolveNext;
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const subscription = {
      unsubscribe() { resolveNext?.({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return this; },
      next() { return new Promise((resolve) => { resolveNext = resolve; }); },
    };
    return {
      subscribe() { return subscription; },
      closed: () => closed,
      async close() { subscription.unsubscribe(); resolveClosed(); },
      push(value) { resolveNext?.({ value: { data: new TextEncoder().encode(JSON.stringify(value)) }, done: false }); },
    };
  };
  const pi = fakePi(messages);
  createExtension(box.env, {
    connectNats: async () => {
      const connection = makeConnection();
      connections.push(connection);
      return connection;
    },
    createFeedbackRoute: () => routes.shift(),
  })(pi);
  await pi.handlers.session_start({}, fakeCtx({ sessionId: 'session-old' }));
  t.after(() => pi.handlers.session_shutdown({}));
  await waitFor(() => connections.length === 1);
  await pi.handlers.session_shutdown({});
  await pi.handlers.session_start({}, fakeCtx({ sessionId: 'session-new' }));
  await waitFor(() => connections.length === 2);

  connections[1].push({ v: 1, type: 'feedback', id: 'old-message', instanceId: 'instance-old', agent: 'pi', session: 'session-old', item: 'review', sourceTurn: 1, createdAt: '2026-10-11T09:00:00.000Z', content: 'old' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.length, 0);
  connections[1].push({ v: 1, type: 'feedback', id: 'new-message', instanceId: 'instance-new', agent: 'pi', session: 'session-new', item: 'review', sourceTurn: 1, createdAt: '2026-10-11T09:00:01.000Z', content: 'new' });
  await waitFor(() => messages.length === 1);
  assert.match(messages[0][0].content, /new/);
});

test('extension: applies titles the CLI host writes', async (t) => {
  const box = sandbox(t);
  const titles = [];
  const pi = fakePi();
  createExtension(box.env)(pi);
  await pi.handlers.session_start({}, fakeCtx({ titles }));
  t.after(() => pi.handlers.session_shutdown({}));

  fs.mkdirSync(box.stateDir(), { recursive: true });
  fs.writeFileSync(path.join(box.stateDir(), 'title.txt'), 'Renaming files\n');
  await waitFor(() => titles.length === 1, { timeoutMs: 5000 });
  assert.deepEqual(titles, ['Renaming files']);
});

test('extension: lifecycle config clears the pane label and sidecar metadata title', async (t) => {
  const box = sandbox(t);
  box.config('lifecycle:\n  clearTitleOnNew: true\n  clearTitleOnResume: false\n');
  const pi = fakePi();
  createExtension({ ...box.env, HERDR_PANE_ID: 'w1:p9' })(pi);
  await pi.handlers.session_start({ reason: 'new' }, fakeCtx());
  t.after(() => pi.handlers.session_shutdown({}));

  assert.deepEqual(box.herdrCalls(), [
    ['pane', 'rename', 'w1:p9', '--clear'],
    ['pane', 'report-metadata', 'w1:p9', '--source', 'agent-sidecar', '--clear-title'],
  ]);

  await pi.handlers.session_start({ reason: 'resume' }, fakeCtx());
  assert.equal(box.herdrCalls().length, 2, 'resume is disabled independently');
});

test('extension: clearing on resume does not restore the saved title immediately', async (t) => {
  const box = sandbox(t);
  box.config('lifecycle:\n  clearTitleOnResume: true\n');
  fs.mkdirSync(box.stateDir(), { recursive: true });
  fs.writeFileSync(path.join(box.stateDir(), 'title.txt'), 'Old title\n');

  const titles = [];
  const pi = fakePi();
  createExtension({ ...box.env, HERDR_PANE_ID: 'w1:p9' })(pi);
  await pi.handlers.session_start({ reason: 'resume' }, fakeCtx({ titles }));
  t.after(() => pi.handlers.session_shutdown({}));
  assert.deepEqual(titles, []);

  fs.writeFileSync(path.join(box.stateDir(), 'title.txt'), 'New title\n');
  await waitFor(() => titles.length === 1, { timeoutMs: 5000 });
  assert.deepEqual(titles, ['New title']);
});

test('Pi package manifest exposes the adapter entry', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.deepEqual(manifest.pi, { extensions: ['./adapters/pi/extension.js'] });
});
