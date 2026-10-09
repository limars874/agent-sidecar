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
  assert.equal(item.model, null);
  assert.equal(item.dir, '/x');
});

test('yaml and json items normalize to the same shape', () => {
  const y = parseItemFile('/x/s.yaml', 'name: sum\neveryTurns: 3\nmodel: a/b\nprompt: hi\noutput:\n  file: out/{session}.md\n');
  const j = parseItemFile('/x/s.json', JSON.stringify({ name: 'sum', everyTurns: 3, model: 'a/b', prompt: 'hi', output: { file: 'out/{session}.md' } }));
  assert.deepEqual({ ...y, file: null }, { ...j, file: null });
  assert.equal(y.context, 'delta');
  assert.deepEqual(y.output, { type: 'file', path: 'out/{session}.md' });
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
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\ncontext: all', /context/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\noutput: stdout', /output must be/],
    ['/x/a.yaml', 'everyTurns: 1\nprompt: a\nname: "bad name"', /invalid name/],
    ['/x/a.json', '[1]', /mapping/],
  ];
  for (const [file, text, re] of cases) assert.throws(() => parseItemFile(file, text), re, text);
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
  assert.equal(loadConfig(dir).model, null);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: a/cheap\ntoolResultLines: 3\n');
  const c = loadConfig(dir);
  assert.equal(c.model, 'a/cheap');
  assert.equal(c.toolResultLines, 3);
  assert.equal(c.timeoutMs, 120000);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'modle: x\n');
  assert.throws(() => loadConfig(dir), /unknown key "modle"/);
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  assert.throws(() => loadConfig(dir), /more than one config file/);
});
