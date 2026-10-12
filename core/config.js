// Global settings: <root>/config.yaml | config.yml | config.json (all optional).
import path from 'node:path';
import { parseDataFile, readFileIfExists } from './files.js';

export const CONFIG_FILES = ['config.yaml', 'config.yml', 'config.json'];

export const DEFAULT_LIFECYCLE = Object.freeze({
  clearTitleOnNew: true,
  clearTitleOnResume: true,
});

export const DEFAULT_FEEDBACK = Object.freeze({
  natsUrl: 'nats://127.0.0.1:4222',
});

export const DEFAULT_IDLE_HANDOFF = Object.freeze({
  enabled: false,
  after: '60m',
  prompt: 'Review the current session. Decide whether important context should be written to or updated in a Handoff document. If not, do nothing. Do not continue the original task or start unrelated development work.',
});

export const DEFAULTS = Object.freeze({
  runner: 'pi',
  effort: null,
  model: null,
  timeoutMs: 120000,
  maxTranscriptChars: 60000,
  toolResultLines: 20,
  feedback: DEFAULT_FEEDBACK,
  lifecycle: DEFAULT_LIFECYCLE,
  idleHandoff: DEFAULT_IDLE_HANDOFF,
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

const FEEDBACK_CHECKS = {
  natsUrl: (v) => typeof v === 'string' && v.trim() !== '',
};

const IDLE_HANDOFF_CHECKS = {
  enabled: (v) => typeof v === 'boolean',
  after: (v) => typeof v === 'string' && parseDurationMs(v) !== null,
  prompt: (v) => typeof v === 'string' && v.trim() !== '' && Buffer.byteLength(v, 'utf8') <= 8 * 1024,
};

export function parseDurationMs(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const result = amount * unit;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function validateFeedback(value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: invalid value for "feedback"`);
  }
  for (const [key, setting] of Object.entries(value)) {
    if (!(key in FEEDBACK_CHECKS)) throw new Error(`${file}: unknown key "feedback.${key}"`);
    if (!FEEDBACK_CHECKS[key](setting)) throw new Error(`${file}: invalid value for "feedback.${key}"`);
  }
}

function validateIdleHandoff(value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: invalid value for "idleHandoff"`);
  }
  for (const [key, setting] of Object.entries(value)) {
    if (!(key in IDLE_HANDOFF_CHECKS)) throw new Error(`${file}: unknown key "idleHandoff.${key}"`);
    if (!IDLE_HANDOFF_CHECKS[key](setting)) throw new Error(`${file}: invalid value for "idleHandoff.${key}"`);
  }
}

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
  if (found.length === 0) {
    return {
      ...DEFAULTS,
      idleHandoff: { ...DEFAULT_IDLE_HANDOFF, afterMs: parseDurationMs(DEFAULT_IDLE_HANDOFF.after) },
    };
  }
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
    if (key === 'feedback') {
      validateFeedback(value, file);
      continue;
    }
    if (key === 'idleHandoff') {
      validateIdleHandoff(value, file);
      continue;
    }
    if (!(key in CHECKS)) throw new Error(`${file}: unknown key "${key}"`);
    if (!CHECKS[key](value)) throw new Error(`${file}: invalid value for "${key}"`);
  }
  return {
    ...DEFAULTS,
    ...raw,
    feedback: { ...DEFAULT_FEEDBACK, ...(raw.feedback ?? {}) },
    lifecycle: { ...DEFAULT_LIFECYCLE, ...(raw.lifecycle ?? {}) },
    idleHandoff: {
      ...DEFAULT_IDLE_HANDOFF,
      ...(raw.idleHandoff ?? {}),
      afterMs: parseDurationMs((raw.idleHandoff ?? DEFAULT_IDLE_HANDOFF).after ?? DEFAULT_IDLE_HANDOFF.after),
    },
  };
}
