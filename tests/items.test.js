import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../core/config.js';
import { loadItems, parseItemFile } from '../core/items.js';

test('markdown item: frontmatter settings, body is the prompt', () => {
  const item = parseItemFile('/x/title.md', '---\neveryTurns: 2\ncontext: session\noutput: title\n---\nName it.\n\n{{transcript}}\n');
  assert.equal(item.name, 'title');
  assert.equal(item.everyTurns, 2);
  assert.equal(item.kind, 'prompt');
  assert.equal(item.prompt, 'Name it.\n\n{{transcript}}');
  assert.equal(item.context, 'session');
  assert.deepEqual(item.output, { type: 'title' });
  assert.equal(item.runner, null);
  assert.equal(item.model, null);
  assert.equal(item.effort, null);
  assert.equal(item.feedback, false);
  assert.equal(item.dir, '/x');
});

test('yaml and json items normalize to the same shape', () => {
  const y = parseItemFile('/x/s.yaml', 'name: sum\neveryTurns: 3\nrunner: pi\nmodel: a/b\neffort: high\nprompt: hi\noutput:\n  file: out/{session}.md\n');
  const j = parseItemFile('/x/s.json', JSON.stringify({ name: 'sum', everyTurns: 3, runner: 'pi', model: 'a/b', effort: 'high', prompt: 'hi', output: { file: 'out/{session}.md' } }));
  assert.deepEqual({ ...y, file: null }, { ...j, file: null });
  assert.equal(y.runner, 'pi');
  assert.equal(y.effort, 'high');
  assert.equal(y.context, 'delta');
  assert.deepEqual(y.output, { type: 'file', path: 'out/{session}.md', mode: 'append' });
});

test('script items and default output', () => {
  const item = parseItemFile('/x/s.yml', 'everyTurns: 1\nscript: ./run.sh\n');
  assert.equal(item.kind, 'script');
  assert.equal(item.script, './run.sh');
  assert.deepEqual(item.output, { type: 'none' });
});

test('invalid items are rejected with a reason', () => {
  const cases = [
    ['/x/a.md', '---\neveryTurns: 1\nprompt: a\n---\nbody too', /both in the frontmatter and in the body/],
    ['/x/a.md', 'no frontmatter', /missing YAML frontmatter/],
    ['/x/a.yaml', 'prompt: a', /everyTurns/],
    ['/x/a.yaml', 'everyTurns: 0\nprompt: a', /everyTurns/],
    ['/x/a.yaml', 'everyTurns: 1', /exactly one of prompt or script/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nscript: b', /exactly one of prompt or script/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nevery: 2', /unknown key "every"/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nrunner: ""', /runner/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\neffort: ""', /effort/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nfeedback: yes', /feedback/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\ncontext: all', /context/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\ncontext:\n  scope: recent', /context.turns/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\ncontext:\n  scope: delta\n  turns: 2', /context.turns/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\ncontext:\n  include: [user, nope]', /context.include/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\noutput: stdout', /output must be/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\noutput:\n  file: summary.md\n  mode: overwrite', /output.mode/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nname: "bad name"', /invalid name/],
    ['/x/a.json', '[1]', /mapping/],
  ];
  for (const [file, text, re] of cases) assert.throws(() => parseItemFile(file, text), re, text);
});

test('context mapping normalizes scope, include, budget and files', () => {
  const item = parseItemFile('/x/summary.yaml', 'everyTurns: 3\ncontext:\n  scope: delta\n  include: [user, assistant, toolCall]\n  maxChars: 12000\n  files:\n    - "out/{agent}/{session}/summary.md"\nprompt: update');
  assert.equal(item.context, 'delta');
  assert.deepEqual(item.contextSpec, {
    scope: 'delta',
    turns: null,
    include: ['user', 'assistant', 'toolCall'],
    maxChars: 12000,
    files: ['out/{agent}/{session}/summary.md'],
  });
});

test('loadItems skips bad files and duplicates, keeps the rest', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'items-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'everyTurns: 1\nprompt: a\n');
  fs.writeFileSync(path.join(dir, 'b.json'), '{"name":"a","everyTurns":1,"prompt":"b"}');
  fs.writeFileSync(path.join(dir, 'c.md'), 'broken');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const { items, errors } = loadItems(dir);
  assert.deepEqual(items.map((i) => i.name), ['a']);
  assert.equal(errors.length, 2);
  assert.match(errors.find((e) => e.file.endsWith('b.json')).message, /duplicate/);
  assert.deepEqual(loadItems(path.join(dir, 'missing')), { items: [], errors: [] });
});

test('config: defaults, overrides, and errors', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadConfig(dir).runner, 'pi');
  assert.equal(loadConfig(dir).effort, null);
  assert.equal(loadConfig(dir).model, null);
  assert.equal(loadConfig(dir).feedback.natsUrl, 'nats://127.0.0.1:4222');
  const defaultHandoff = loadConfig(dir).idleHandoff;
  assert.equal(defaultHandoff.enabled, false);
  assert.equal(defaultHandoff.after, '60m');
  assert.equal(defaultHandoff.afterMs, 60 * 60 * 1000);
  assert.equal(typeof defaultHandoff.prompt, 'string');
  assert.deepEqual(loadConfig(dir).lifecycle, { clearTitleOnNew: true, clearTitleOnResume: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    'runner: pi\neffort: high\nmodel: a/cheap\ntoolResultLines: 3\nfeedback:\n  natsUrl: nats://127.0.0.1:14222\nlifecycle:\n  clearTitleOnNew: false\n  clearTitleOnResume: true\nidleHandoff:\n  enabled: true\n  after: 2s\n  prompt: Check handoff\n',
  );
  const c = loadConfig(dir);
  assert.equal(c.runner, 'pi');
  assert.equal(c.effort, 'high');
  assert.equal(c.model, 'a/cheap');
  assert.equal(c.toolResultLines, 3);
  assert.equal(c.feedback.natsUrl, 'nats://127.0.0.1:14222');
  assert.equal(c.timeoutMs, 120000);
  assert.deepEqual(c.idleHandoff, { enabled: true, after: '2s', afterMs: 2000, prompt: 'Check handoff' });
  assert.deepEqual(c.lifecycle, { clearTitleOnNew: false, clearTitleOnResume: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'lifecycle:\n  clearTitleOnStart: false\n');
  assert.throws(() => loadConfig(dir), /unknown key "lifecycle.clearTitleOnStart"/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'lifecycle:\n  clearTitleOnNew: yes\n');
  assert.throws(() => loadConfig(dir), /invalid value for "lifecycle.clearTitleOnNew"/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'effort: ""\n');
  assert.throws(() => loadConfig(dir), /invalid value for "effort"/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'idleHandoff:\n  enabled: true\n  after: forever\n');
  assert.throws(() => loadConfig(dir), /invalid value for "idleHandoff.after"/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'modle: x\n');
  assert.throws(() => loadConfig(dir), /unknown key "modle"/);
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  assert.throws(() => loadConfig(dir), /more than one config file/);
});
