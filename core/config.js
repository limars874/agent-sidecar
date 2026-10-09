// Global settings: <root>/config.yaml | config.yml | config.json (all optional).
import path from 'node:path';
import { parseDataFile, readFileIfExists } from './files.js';

export const CONFIG_FILES = ['config.yaml', 'config.yml', 'config.json'];

export const DEFAULTS = Object.freeze({
  model: null,
  timeoutMs: 120000,
  maxTranscriptChars: 60000,
  toolResultLines: 20,
});

const CHECKS = {
  model: (v) => typeof v === 'string' && v.trim() !== '',
  timeoutMs: (v) => Number.isInteger(v) && v > 0,
  maxTranscriptChars: (v) => Number.isInteger(v) && v > 0,
  toolResultLines: (v) => Number.isInteger(v) && v >= 0,
};

export function loadConfig(root) {
  const found = CONFIG_FILES.map((name) => path.join(root, name))
    .map((file) => ({ file, text: readFileIfExists(file) }))
    .filter((f) => f.text !== undefined);
  if (found.length === 0) return { ...DEFAULTS };
  if (found.length > 1) throw new Error(`more than one config file in ${root}: ${found.map((f) => path.basename(f.file)).join(', ')}`);

  const { file, text } = found[0];
  let raw;
  try {
    raw = parseDataFile(file, text);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in CHECKS)) throw new Error(`${file}: unknown key "${key}"`);
    if (!CHECKS[key](value)) throw new Error(`${file}: invalid value for "${key}"`);
  }
  return { ...DEFAULTS, ...raw };
}
