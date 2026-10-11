// Item loader (CONTRACT.md "Items"). Every file format becomes the same Item:
//   { name, file, dir, everyTurns, runner, model, effort, feedback, kind: 'prompt'|'script', prompt, script,
//     context, contextSpec, output: {type:'title'}|{type:'file', path, mode}|{type:'none'} }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_EXTS, MARKDOWN_EXTS, parseDataFile, parseMarkdown } from './files.js';

const KEYS = new Set(['name', 'everyTurns', 'runner', 'model', 'effort', 'feedback', 'prompt', 'script', 'context', 'output']);
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const CONTEXT_SCOPES = new Set(['delta', 'session', 'recent']);
const CONTEXT_ROLES = new Set(['user', 'assistant', 'toolCall', 'toolResult']);
const CONTEXT_KEYS = new Set(['scope', 'turns', 'include', 'maxChars', 'files']);

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

export function parseContext(raw) {
  if (raw === undefined || raw === null) return normalizeContext({});
  if (typeof raw === 'string') return normalizeContext({ scope: raw });
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('context must be a string or mapping');
  return normalizeContext(raw);
}

function normalizeContext(raw) {
  for (const key of Object.keys(raw)) {
    if (!CONTEXT_KEYS.has(key)) throw new Error(`unknown key "context.${key}"`);
  }
  const scope = raw.scope ?? 'delta';
  if (!CONTEXT_SCOPES.has(scope)) throw new Error('context.scope must be "delta", "session" or "recent"');

  const turns = raw.turns ?? null;
  if (turns !== null && (!Number.isInteger(turns) || turns < 1)) throw new Error('context.turns must be an integer >= 1');
  if (scope === 'recent' && turns === null) throw new Error('context.turns is required when context.scope is "recent"');
  if (scope !== 'recent' && turns !== null) throw new Error('context.turns is only valid when context.scope is "recent"');

  const include = raw.include ?? null;
  if (include !== null) {
    if (!Array.isArray(include) || include.length === 0) throw new Error('context.include must be a non-empty list');
    if (new Set(include).size !== include.length || include.some((role) => !CONTEXT_ROLES.has(role))) {
      throw new Error('context.include entries must be unique user, assistant, toolCall or toolResult roles');
    }
  }

  const maxChars = raw.maxChars ?? null;
  if (maxChars !== null && (!Number.isInteger(maxChars) || maxChars < 1)) throw new Error('context.maxChars must be an integer >= 1');

  const files = raw.files ?? [];
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file.trim() === '')) {
    throw new Error('context.files must be a list of non-empty strings');
  }

  return { scope, turns, include, maxChars, files };
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

  if (raw.feedback !== undefined && typeof raw.feedback !== 'boolean') {
    throw new Error('feedback must be a boolean');
  }

  const hasPrompt = raw.prompt !== undefined;
  const hasScript = raw.script !== undefined;
  if (hasPrompt === hasScript) throw new Error('exactly one of prompt or script is required');
  const work = hasPrompt ? raw.prompt : raw.script;
  if (typeof work !== 'string' || work.trim() === '') throw new Error(`${hasPrompt ? 'prompt' : 'script'} must be a non-empty string`);

  const contextSpec = parseContext(raw.context);

  return {
    name,
    file,
    dir: path.dirname(file),
    everyTurns: raw.everyTurns,
    runner: raw.runner ?? null,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    feedback: raw.feedback ?? false,
    kind: hasPrompt ? 'prompt' : 'script',
    prompt: hasPrompt ? raw.prompt : null,
    script: hasScript ? raw.script : null,
    context: contextSpec.scope,
    contextSpec,
    output: parseOutput(raw.output),
  };
}

function parseOutput(output) {
  if (output === undefined || output === 'none') return { type: 'none' };
  if (output === 'title') return { type: 'title' };
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const keys = Object.keys(output);
    const validKeys = keys.every((key) => key === 'file' || key === 'mode');
    const mode = output.mode ?? 'append';
    if (output.mode !== undefined && mode !== 'append' && mode !== 'replace') {
      throw new Error('output.mode must be "append" or "replace"');
    }
    if (validKeys && keys.includes('file') && typeof output.file === 'string' && output.file.trim() !== '') {
      return { type: 'file', path: output.file, mode };
    }
  }
  throw new Error('output must be "title", "none" or { file: <path template>, mode?: "append"|"replace" }');
}
