import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildEvent, createExtension } from '../adapters/pi/extension.js';
import { callPiModel, PI_ARGS, preparePiModel } from '../runners/pi.js';
import { readPiSession } from '../adapters/pi/transcript.js';
import { countTurns } from '../core/transcript.js';
import { PI_SESSION, PI_SESSION_ID, readJsonLines, sandbox, waitFor } from './helpers.js';

test('Pi session: active branch only, roles mapped, partial last line ignored', () => {
  const t = readPiSession(PI_SESSION);
  assert.equal(t.session, PI_SESSION_ID);
  assert.equal(t.cwd, '/work/demo');
  assert.equal(t.model, 'anthropic/m', 'latest assistant reply on the branch');
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
function fakePi() {
  const handlers = {};
  return { handlers, on: (name, fn) => void (handlers[name] = fn) };
}

function fakeCtx({ file = PI_SESSION, titles = [] } = {}) {
  return {
    hasUI: true,
    model: { provider: 'anthropic', id: 'claude-x' },
    ui: { setTitle: (t) => titles.push(t), notify: () => {} },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => PI_SESSION_ID,
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
