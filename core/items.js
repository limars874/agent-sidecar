// Item loader (CONTRACT.md "Items"). Every file format becomes the same Item:
//   { name, file, dir, everyTurns, runner, model, effort, kind: 'prompt'|'script', prompt, script,
//     context: 'delta'|'session', output: {type:'title'}|{type:'file', path}|{type:'none'} }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_EXTS, MARKDOWN_EXTS, parseDataFile, parseMarkdown } from './files.js';

const KEYS = new Set(['name', 'everyTurns', 'runner', 'model', 'effort', 'prompt', 'script', 'context', 'output']);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Returns { items, errors }; a file with an error is skipped, the others still load.
export function loadItems(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [], errors: [] };
    throw err;
  }

  const items = [];
  const errors = [];
  for (const name of names) {
    const ext = path.extname(name);
    if (!MARKDOWN_EXTS.has(ext) && !DATA_EXTS.has(ext)) continue;
    const file = path.join(dir, name);
    try {
      const item = parseItemFile(file, fs.readFileSync(file, 'utf8'));
      if (items.some((other) => other.name === item.name)) throw new Error(`duplicate item name "${item.name}"`);
      items.push(item);
    } catch (err) {
      errors.push({ file, message: err.message });
    }
  }
  return { items, errors };
}

export function parseItemFile(file, text) {
  let raw;
  if (MARKDOWN_EXTS.has(path.extname(file))) {
    const { data, body } = parseMarkdown(text);
    if (body !== '' && 'prompt' in data) throw new Error('prompt is set both in the frontmatter and in the body');
    raw = body === '' ? data : { ...data, prompt: body };
  } else {
    raw = parseDataFile(file, text);
  }
  return validateItem(raw, file);
}

function validateItem(raw, file) {
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new Error(`unknown key "${key}"`);
  }

  const name = raw.name ?? path.basename(file, path.extname(file));
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid name "${name}" (letters, digits, . _ -)`);

  if (!Number.isInteger(raw.everyTurns) || raw.everyTurns < 1) throw new Error('everyTurns must be an integer >= 1');

  if (raw.runner !== undefined && (typeof raw.runner !== 'string' || raw.runner.trim() === '')) {
    throw new Error('runner must be a non-empty string');
  }

  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.trim() === '')) {
    throw new Error('model must be a non-empty string');
  }

  if (raw.effort !== undefined && (typeof raw.effort !== 'string' || raw.effort.trim() === '')) {
    throw new Error('effort must be a non-empty string');
  }

  const hasPrompt = raw.prompt !== undefined;
  const hasScript = raw.script !== undefined;
  if (hasPrompt === hasScript) throw new Error('exactly one of prompt or script is required');
  const work = hasPrompt ? raw.prompt : raw.script;
  if (typeof work !== 'string' || work.trim() === '') throw new Error(`${hasPrompt ? 'prompt' : 'script'} must be a non-empty string`);

  const context = raw.context ?? 'delta';
  if (context !== 'delta' && context !== 'session') throw new Error('context must be "delta" or "session"');

  return {
    name,
    file,
    dir: path.dirname(file),
    everyTurns: raw.everyTurns,
    runner: raw.runner ?? null,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    kind: hasPrompt ? 'prompt' : 'script',
    prompt: hasPrompt ? raw.prompt : null,
    script: hasScript ? raw.script : null,
    context,
    output: parseOutput(raw.output),
  };
}

function parseOutput(output) {
  if (output === undefined || output === 'none') return { type: 'none' };
  if (output === 'title') return { type: 'title' };
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const keys = Object.keys(output);
    if (keys.length === 1 && keys[0] === 'file' && typeof output.file === 'string' && output.file.trim() !== '') {
      return { type: 'file', path: output.file };
    }
  }
  throw new Error('output must be "title", "none" or { file: <path template> }');
}
