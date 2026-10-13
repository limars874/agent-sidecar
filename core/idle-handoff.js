// Legacy compatibility facade. New code must import ./idle-prompt.js.
import {
  IDLE_STREAM_NAME,
  IDLE_SUBJECT_PREFIX,
  IDLE_STREAM_SUBJECTS,
  IDLE_MAX_PAYLOAD_BYTES,
  IDLE_MAX_PROMPT_BYTES,
  IDLE_TIMEOUT_MS,
  IDLE_CONSUMER_INACTIVE_MS,
  IDLE_STREAM_MAX_AGE_MS,
  createIdleRoute,
  idleConsumerName,
  validateIdleRoute,
  buildIdlePromptEnvelope,
  decodeIdlePromptMessage,
  validateIdlePromptEnvelope,
  emptyIdlePromptState,
  normalizeIdlePromptState,
  planIdlePrompt,
  markIdlePromptScheduled,
  markIdlePromptScheduleFailed,
  markIdlePromptTriggered,
  completeIdlePrompt,
  ensureIdleStream,
  ensureIdleConsumer,
  deleteIdleConsumer,
  publishIdlePromptPlan,
} from './idle-prompt.js';

export const HANDOFF_STREAM_NAME = IDLE_STREAM_NAME;
export const HANDOFF_SUBJECT_PREFIX = IDLE_SUBJECT_PREFIX;
export const HANDOFF_STREAM_SUBJECTS = IDLE_STREAM_SUBJECTS;
export const HANDOFF_MAX_PAYLOAD_BYTES = IDLE_MAX_PAYLOAD_BYTES;
export const HANDOFF_MAX_PROMPT_BYTES = IDLE_MAX_PROMPT_BYTES;
export const HANDOFF_TIMEOUT_MS = IDLE_TIMEOUT_MS;
export const HANDOFF_CONSUMER_INACTIVE_MS = IDLE_CONSUMER_INACTIVE_MS;
export const HANDOFF_STREAM_MAX_AGE_MS = IDLE_STREAM_MAX_AGE_MS;

export const createHandoffRoute = createIdleRoute;
export const handoffConsumerName = idleConsumerName;
export const validateHandoffRoute = validateIdleRoute;
export const validateHandoffEnvelope = validateIdlePromptEnvelope;
export const decodeHandoffMessage = decodeIdlePromptMessage;
export const emptyIdleHandoffState = emptyIdlePromptState;
export const normalizeHandoffState = normalizeIdlePromptState;
export const ensureHandoffStream = ensureIdleStream;
export const ensureHandoffConsumer = ensureIdleConsumer;
export const deleteHandoffConsumer = deleteIdleConsumer;

function toIdleState(state) {
  if (state?.idle === undefined && state?.idleHandoff !== undefined) {
    const { idleHandoff, ...rest } = state;
    return { ...rest, idle: structuredClone(idleHandoff) };
  }
  return state;
}

function fromIdleState(state, legacy) {
  if (!legacy) return state;
  const next = { ...state };
  if (next.idle !== undefined) {
    next.idleHandoff = next.idle;
    delete next.idle;
  }
  return next;
}

function legacyEvent(event) {
  return { ...event, idleRoute: event.idleRoute ?? event.handoffRoute };
}

function legacyConfig(config) {
  return config.idle ? config : { ...config, idle: config.idleHandoff };
}

export function buildHandoffEnvelope({ event, ...rest }) {
  return buildIdlePromptEnvelope({ event: legacyEvent(event), ...rest });
}

export function planIdleHandoff({ state, event, config, ...rest }) {
  const legacy = state?.idleHandoff !== undefined || state?.idle === undefined;
  const result = planIdlePrompt({
    ...rest,
    config: legacyConfig(config),
    event: legacyEvent(event),
    state: toIdleState(state),
  });
  return { ...result, state: fromIdleState(result.state, legacy) };
}

export function markIdleHandoffScheduled(state, planId, now) {
  const legacy = state?.idleHandoff !== undefined;
  return fromIdleState(markIdlePromptScheduled(toIdleState(state), planId, now), legacy);
}

export function markIdleHandoffScheduleFailed(state, planId, warning, now) {
  const legacy = state?.idleHandoff !== undefined;
  return fromIdleState(markIdlePromptScheduleFailed(toIdleState(state), planId, warning, now), legacy);
}

export function markIdleHandoffTriggered(state, { planId, now } = {}) {
  const legacy = state?.idleHandoff !== undefined;
  const result = markIdlePromptTriggered(toIdleState(state), { idlePromptId: planId, now });
  return { ...result, state: fromIdleState(result.state, legacy) };
}

export function completeIdleHandoff(state, { handoffId, now } = {}) {
  const legacy = state?.idleHandoff !== undefined;
  const result = completeIdlePrompt(toIdleState(state), { idlePromptId: handoffId, now });
  return { ...result, state: fromIdleState(result.state, legacy) };
}

export async function publishIdleHandoffPlan({ event, ...rest }) {
  return publishIdlePromptPlan({
    ...rest,
    transportPrefix: 'agent-sidecar-handoff',
    event: legacyEvent(event),
  });
}
