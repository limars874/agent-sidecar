// Global settings: <root>/config.yaml | config.yml | config.json (all optional).
import path from 'node:path';
import { parseDataFile, readFileIfExists } from './files.js';

export const CONFIG_FILES = ['config.yaml', 'config.yml', 'config.json'];

export const DEFAULT_LIFECYCLE = Object.freeze({
  clearTitleOnNew: true,
  clearTitleOnResume: true,
});

export const DEFAULTS = Object.freeze({
  runner: 'pi',
  effort: null,
  model: null,
  timeoutMs: 120000,
  maxTranscriptChars: 60000,
  toolResultLines: 20,
  lifecycle: DEFAULT_LIFECYCLE,
});

const CHECKS = {
  runner: (v) => typeof v === 'string' && v.trim() !== '',
  effort: (v) => typeof v === 'string' && v.trim() !== '',
  model: (v) => typeof v === 'string' && v.trim() !== '',
  timeoutMs: (v) => Number.isInteger(v) && v > 0,
  maxTranscriptChars: (v) => Number.isInteger(v) && v > 0,
  toolResultLines: (v) => Number.isInteger(v) && v >= 0,
};

const LIFECYCLE_CHECKS = {
  clearTitleOnNew: (v) => typeof v === 'boolean',
  clearTitleOnResume: (v) => typeof v === 'boolean',
};

function validateLifecycle(value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: invalid value for "lifecycle"`);
  }
  for (const [key, setting] of Object.entries(value)) {
    if (!(key in LIFECYCLE_CHECKS)) throw new Error(`${file}: unknown key "lifecycle.${key}"`);
    if (!LIFECYCLE_CHECKS[key](setting)) throw new Error(`${file}: invalid value for "lifecycle.${key}"`);
  }
}

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
    if (key === 'lifecycle') {
      validateLifecycle(value, file);
      continue;
    }
    if (!(key in CHECKS)) throw new Error(`${file}: unknown key "${key}"`);
    if (!CHECKS[key](value)) throw new Error(`${file}: invalid value for "${key}"`);
  }
  return { ...DEFAULTS, ...raw, lifecycle: { ...DEFAULT_LIFECYCLE, ...(raw.lifecycle ?? {}) } };
}
