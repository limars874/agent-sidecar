// Parsing for the user-editable files (items, global config): YAML, JSON and
// Markdown with YAML frontmatter.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const MARKDOWN_EXTS = new Set(['.md']);
export const DATA_EXTS = new Set(['.yaml', '.yml', '.json']);

export function parseDataFile(file, text) {
  const value = path.extname(file) === '.json' ? JSON.parse(text) : YAML.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('top level must be a mapping');
  }
  return value;
}

// Returns { data, body }. The frontmatter is required: it holds everyTurns.
export function parseMarkdown(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing YAML frontmatter (--- ... ---)');
  const data = YAML.parse(m[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter must be a mapping');
  return { data, body: m[2].trim() };
}

export function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}
