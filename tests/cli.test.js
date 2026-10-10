import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cli, event, PI_SESSION, PI_SESSION_ID, readJsonLines, sandbox, waitFor } from './helpers.js';

const TITLE_ITEM = '---\neveryTurns: 2\ncontext: session\noutput: title\n---\nTitle this.\n\n{{transcript}}\n';
const SUMMARY_ITEM = 'everyTurns: 1\nmodel: item/model\noutput:\n  file: out/{agent}/{session}/summary.md\nprompt: "Summarize turns {{fromTurn}}..{{toTurn}}"\n';

test('event --foreground: due items run, outputs written, cursors saved', (t) => {
  const box = sandbox(t);
  box.item('title.md', TITLE_ITEM);
  box.item('summary.yaml', SUMMARY_ITEM);
  box.config('model: global/model\n');
  const env = { ...box.env, FAKE_PI_REPLY: '"Rename files"' };

  const r = cli(['event', '--foreground', '--json', JSON.stringify(event({ pane: 'w1:p3' }))], env);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.deepEqual(out.scheduled.sort(), ['summary', 'title']);
  assert.equal(out.turn, 2);

  // Model priority as seen by pi -p: item model for summary, global model for title.
  const calls = box.piCalls();
  const modelOf = (re) => calls.find((c) => re.test(c.prompt)).args.at(-1);
  assert.equal(modelOf(/^Summarize turns 0\.\.2/), 'item/model');
  assert.equal(modelOf(/^Title this\./), 'global/model');
  assert.match(calls.find((c) => /^Title/.test(c.prompt)).prompt, /\[tool bash\]\na\.txt\nb\.txt/);
  assert.doesNotMatch(calls[0].prompt + calls[1].prompt, /Abandoned/);

  assert.equal(fs.readFileSync(path.join(box.stateDir(), 'title.txt'), 'utf8'), 'Rename files\n');
  assert.deepEqual(box.herdrCalls(), [['pane', 'report-metadata', 'w1:p3', '--source', 'agent-sidecar', '--title', 'Rename files']]);
  const summary = fs.readFileSync(path.join(box.root, 'out', 'pi', PI_SESSION_ID, 'summary.md'), 'utf8');
  assert.match(summary, /^## .* · summary · pi 0199-test-session · turns 1–2\n\n"Rename files"\n/);

  const state = JSON.parse(fs.readFileSync(path.join(box.stateDir(), 'state.json'), 'utf8'));
  assert.equal(state.items.title.lastTurn, 2);
  assert.equal(state.items.summary.running, undefined);
  assert.equal(state.items.summary.lastRun.status, 'ok');
  assert.equal(state.items.summary.completedThrough, 2);
  assert.equal(state.items.summary.scheduledThrough, 2);
  assert.equal(fs.readdirSync(path.join(box.stateDir(), 'jobs')).length, 0, 'job file removed');
  assert.deepEqual(readJsonLines(path.join(box.stateDir(), 'runs.jsonl')).map((x) => x.status), ['ok', 'ok']);
  assert.deepEqual(readJsonLines(path.join(box.stateDir(), 'runs.jsonl')).map((x) => x.runner), ['pi', 'pi']);

  // Reporting the same turn again schedules nothing.
  const again = cli(['event', '--foreground', '--json', JSON.stringify(event())], env).json();
  assert.deepEqual(again.scheduled, []);
});

test('summary snapshot replaces the previous file and feeds it into the next delta', (t) => {
  const box = sandbox(t);
  box.item('summary.yaml', 'everyTurns: 1\ncontext:\n  scope: delta\n  include: [user, assistant]\n  files:\n    - "out/{agent}/{session}/summary.md"\noutput:\n  file: out/{agent}/{session}/summary.md\n  mode: replace\nprompt: Summarize');
  const first = cli(['event', '--foreground', '--json', JSON.stringify(event({ turn: 1 }))], { ...box.env, FAKE_PI_REPLY: 'snapshot one' });
  assert.equal(first.code, 0, first.stderr);
  const second = cli(['event', '--foreground', '--json', JSON.stringify(event({ turn: 2 }))], { ...box.env, FAKE_PI_REPLY: 'snapshot two' });
  assert.equal(second.code, 0, second.stderr);
  const file = path.join(box.root, 'out', 'pi', PI_SESSION_ID, 'summary.md');
  assert.equal(fs.readFileSync(file, 'utf8'), 'snapshot two\n');
  assert.match(box.piCalls()[1].prompt, /\[file out\/\{agent\}\/\{session\}\/summary\.md\]\nsnapshot one/);

  // Repeating a replace run keeps one current snapshot rather than duplicating history.
  const repeat = cli(['run', 'summary', '--agent', 'pi', '--session', PI_SESSION], { ...box.env, FAKE_PI_REPLY: 'snapshot two' });
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), 'snapshot two\n');
});

test('append output may duplicate records when a run is repeated', (t) => {
  const box = sandbox(t);
  box.item('log.yaml', 'everyTurns: 1\noutput:\n  file: out/log.md\nprompt: Log');
  const args = ['run', 'log', '--agent', 'pi', '--session', PI_SESSION];
  for (let i = 0; i < 2; i += 1) {
    const r = cli(args, { ...box.env, FAKE_PI_REPLY: 'same record' });
    assert.equal(r.code, 0, r.stderr);
  }
  const output = fs.readFileSync(path.join(box.root, 'out', 'log.md'), 'utf8');
  assert.equal((output.match(/^## /gm) ?? []).length, 2);
  assert.equal((output.match(/same record/g) ?? []).length, 2);
});

test('event: session model is the fallback; failures are recorded, not fatal', (t) => {
  const box = sandbox(t);
  box.item('note.md', '---\neveryTurns: 1\n---\nNote it.');
  const r = cli(['event', '--foreground'], { ...box.env, FAKE_PI_EXIT: '2' }, JSON.stringify(event({ turn: null })));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().turn, 2, 'turn counted from the transcript when the event has none');
  assert.equal(box.piCalls()[0].args.at(-1), 'anthropic/session-model');
  const [run] = readJsonLines(path.join(box.stateDir(), 'runs.jsonl'));
  assert.equal(run.status, 'error');
  assert.match(run.error, /pi -p exited 2/);
  const failedState = JSON.parse(fs.readFileSync(path.join(box.stateDir(), 'state.json'), 'utf8'));
  assert.equal(failedState.items.note.lastTurn, 0);
  assert.equal(failedState.items.note.completedThrough, 0);
  assert.equal(failedState.items.note.scheduledThrough, 2);
  assert.match(fs.readFileSync(path.join(box.stateDir(), 'sidecar.log'), 'utf8'), /note: pi -p exited 2/);

  const retry = cli(['event', '--foreground', '--json', JSON.stringify(event({ turn: 2 }))], box.env);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(readJsonLines(path.join(box.stateDir(), 'runs.jsonl')).at(-1).status, 'ok');
  const retriedState = JSON.parse(fs.readFileSync(path.join(box.stateDir(), 'state.json'), 'utf8'));
  assert.equal(retriedState.items.note.lastTurn, 2);
  assert.equal(retriedState.items.note.completedThrough, 2);
});

test('event: global effort reaches the default Pi runner', (t) => {
  const box = sandbox(t);
  box.item('note.md', '---\neveryTurns: 1\n---\nNote it.');
  box.config('model: global/model\neffort: high\n');
  cli(['event', '--foreground', '--json', JSON.stringify(event())], box.env);
  const call = box.piCalls()[0];
  assert.deepEqual(call.args.slice(-4), ['--model', 'global/model', '--thinking', 'high']);
  assert.equal(readJsonLines(path.join(box.stateDir(), 'runs.jsonl'))[0].effort, 'high');
});

test('event: jcode runner maps the model and parses JSON text', (t) => {
  const box = sandbox(t);
  box.item('note.yaml', 'everyTurns: 1\nrunner: jcode\nmodel: openai-codex/gpt-5.6-luna:xhigh\neffort: xhigh\noutput:\n  file: out/jcode.md\nprompt: Summarize');
  const r = cli(['event', '--foreground', '--json', JSON.stringify(event())], { ...box.env, FAKE_JCODE_REPLY: 'jcode answer' });
  assert.equal(r.code, 0, r.stderr);
  const [call] = box.jcodeCalls();
  const modelIndex = call.args.indexOf('--model');
  assert.equal(call.args[modelIndex - 2], '--provider');
  assert.equal(call.args[modelIndex - 1], 'openai');
  assert.equal(call.args[modelIndex + 1], 'gpt-5.6-luna');
  assert.match(call.prompt, /Summarize/);
  assert.match(call.prompt, /List the files/);
  const [run] = readJsonLines(path.join(box.stateDir(), 'runs.jsonl'));
  assert.equal(run.runner, 'jcode');
  assert.equal(run.effort, 'xhigh');
  assert.match(fs.readFileSync(path.join(box.root, 'out', 'jcode.md'), 'utf8'), /jcode answer/);
});

test('event: no model anywhere is an item error', (t) => {
  const box = sandbox(t);
  box.item('note.md', '---\neveryTurns: 1\n---\nNote it.');
  cli(['event', '--foreground', '--json', JSON.stringify(event({ model: null }))], box.env);
  assert.match(readJsonLines(path.join(box.stateDir(), 'runs.jsonl'))[0].error, /no model/);
  assert.equal(box.piCalls().length, 0);
});

test('event without --foreground hands the job to a detached worker', async (t) => {
  const box = sandbox(t);
  box.item('summary.yaml', SUMMARY_ITEM);
  const r = cli(['event', '--json', JSON.stringify(event())], { ...box.env, FAKE_PI_REPLY: 'bg' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().scheduled, ['summary']);
  const file = path.join(box.root, 'out', 'pi', PI_SESSION_ID, 'summary.md');
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('bg'));
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(box.stateDir(), 'state.json'), 'utf8')).items.summary.lastRun);
});

test('event: invalid input exits 1 with a reason', (t) => {
  const box = sandbox(t);
  let r = cli(['event', '--json', '{nope'], box.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  r = cli(['event', '--json', JSON.stringify(event({ agent: 'codex' }))], box.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown agent "codex"/);
  r = cli(['event', '--bogus'], box.env);
  assert.equal(r.code, 64);
});

test('script items get the context on stdin and their stdout goes to the output', (t) => {
  const box = sandbox(t);
  fs.writeFileSync(
    path.join(box.root, 'items', 'count.js'),
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);console.log(`${i.item} ${i.agent} ${i.fromTurn}-${i.toTurn} ${i.runner} ${i.model} ${i.transcript.includes('c.txt')}`)})",
  );
  box.item('count.json', JSON.stringify({ everyTurns: 1, script: 'node count.js', output: { file: 'out/count.md' } }));
  box.item('fail.yaml', 'everyTurns: 1\nscript: "echo boom >&2; exit 4"\n');
  cli(['event', '--foreground', '--json', JSON.stringify(event())], box.env);
  assert.match(fs.readFileSync(path.join(box.root, 'out', 'count.md'), 'utf8'), /\n\ncount pi 0-2 pi anthropic\/session-model true\n/);
  const runs = readJsonLines(path.join(box.stateDir(), 'runs.jsonl'));
  assert.match(runs.find((x) => x.item === 'fail').error, /script exited 4: boom/);
  assert.equal(box.piCalls().length, 0);
});

test('run: manual run and dry run over a session file, cursor untouched', (t) => {
  const box = sandbox(t);
  box.item('summary.yaml', SUMMARY_ITEM);
  const base = ['run', 'summary', '--agent', 'pi', '--session', PI_SESSION];

  const dry = cli([...base, '--dry-run', '--from-turn', '1'], box.env);
  assert.equal(dry.code, 0, dry.stderr);
  const d = dry.json();
  assert.equal(d.model, 'item/model');
  assert.equal(d.fromTurn, 1);
  assert.equal(d.toTurn, 2);
  assert.match(d.prompt, /^Summarize turns 1\.\.2/);
  assert.doesNotMatch(d.prompt, /List the files/);
  assert.equal(box.piCalls().length, 0);

  const real = cli(base, { ...box.env, FAKE_PI_REPLY: 'manual summary' });
  assert.equal(real.code, 0, real.stderr);
  assert.equal(real.json().runner, 'pi');
  assert.equal(real.json().text, 'manual summary');
  assert.match(fs.readFileSync(path.join(box.root, 'out', 'pi', PI_SESSION_ID, 'summary.md'), 'utf8'), /manual summary/);
  assert.equal(fs.existsSync(path.join(box.stateDir(), 'state.json')), false, 'run does not schedule or move cursors');

  // Without --model, an item with no model of its own uses the model recorded in the session.
  box.item('plain.md', '---\neveryTurns: 1\n---\nNote it.');
  const plain = cli(['run', 'plain', '--agent', 'pi', '--session', PI_SESSION, '--dry-run'], box.env);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.json().model, 'anthropic/m');

  assert.equal(cli([...base, '--to-turn', '9'], box.env).code, 1);
  assert.match(cli(['run', 'missing', '--agent', 'pi', '--session', PI_SESSION], box.env).stderr, /no item "missing"/);
  assert.equal(cli(['run', 'summary', '--session', PI_SESSION], box.env).code, 64);
});

test('items: lists valid items and reports broken ones', (t) => {
  const box = sandbox(t);
  box.item('title.md', TITLE_ITEM);
  box.item('broken.yaml', 'everyTurns: x\nprompt: a\n');
  const r = cli(['items'], box.env);
  assert.equal(r.code, 1);
  assert.equal(r.json().name, 'title');
  assert.match(r.stderr, /broken\.yaml: everyTurns/);
});

test('the shipped examples load cleanly', (t) => {
  const box = sandbox(t);
  const examples = path.resolve(import.meta.dirname, '../examples');
  for (const f of fs.readdirSync(path.join(examples, 'items'))) {
    fs.copyFileSync(path.join(examples, 'items', f), path.join(box.root, 'items', f));
  }
  fs.copyFileSync(path.join(examples, 'config.yaml'), path.join(box.root, 'config.yaml'));
  const r = cli(['items'], box.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l).name).sort(), ['knowledge', 'summary', 'title', 'turn-log']);
  const script = cli(['run', 'turn-log', '--agent', 'pi', '--session', PI_SESSION], box.env);
  assert.equal(script.code, 0, script.stderr);
  assert.equal(script.json().text.trim(), 'reached turn 2 in /work/demo');
});
