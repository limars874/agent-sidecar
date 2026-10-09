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
  assert.equal(fs.readdirSync(path.join(box.stateDir(), 'jobs')).length, 0, 'job file removed');
  assert.deepEqual(readJsonLines(path.join(box.stateDir(), 'runs.jsonl')).map((x) => x.status), ['ok', 'ok']);

  // Reporting the same turn again schedules nothing.
  const again = cli(['event', '--foreground', '--json', JSON.stringify(event())], env).json();
  assert.deepEqual(again.scheduled, []);
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
  assert.match(fs.readFileSync(path.join(box.stateDir(), 'sidecar.log'), 'utf8'), /note: pi -p exited 2/);
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
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);console.log(`${i.item} ${i.agent} ${i.fromTurn}-${i.toTurn} ${i.model} ${i.transcript.includes('c.txt')}`)})",
  );
  box.item('count.json', JSON.stringify({ everyTurns: 1, script: 'node count.js', output: { file: 'out/count.md' } }));
  box.item('fail.yaml', 'everyTurns: 1\nscript: "echo boom >&2; exit 4"\n');
  cli(['event', '--foreground', '--json', JSON.stringify(event())], box.env);
  assert.match(fs.readFileSync(path.join(box.root, 'out', 'count.md'), 'utf8'), /\n\ncount pi 0-2 anthropic\/session-model true\n/);
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
