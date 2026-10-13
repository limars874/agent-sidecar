// The shared event (CONTRACT.md "Event"). Every adapter reports a finished
// turn as one of these; nothing else crosses from an agent into the core.
import { validateIdleRoute } from './idle-prompt.js';

export const EVENT_VERSION = 1;

const optionalString = (v) => v === undefined || v === null || (typeof v === 'string' && v !== '');

function validateFeedbackRoute(raw, session) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('feedbackRoute must be an object');
  if (raw.v !== 1) throw new Error(`unsupported feedbackRoute version ${JSON.stringify(raw.v)} (expected 1)`);
  for (const key of ['instanceId', 'replySubject', 'session']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') throw new Error(`feedbackRoute.${key} must be a non-empty string`);
    if (raw[key].length > 256) throw new Error(`feedbackRoute.${key} is too long`);
  }
  if (/\s|[>*]/.test(raw.replySubject)) throw new Error('feedbackRoute.replySubject must be a concrete NATS subject');
  if (raw.session !== session) throw new Error('feedbackRoute.session must match event.session');
  return { v: 1, instanceId: raw.instanceId, replySubject: raw.replySubject, session: raw.session };
}

export function validateEvent(raw, knownAgents) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('event must be a JSON object');
  if (raw.v !== EVENT_VERSION) throw new Error(`unsupported event version ${JSON.stringify(raw.v)} (expected ${EVENT_VERSION})`);
  if (!knownAgents.includes(raw.agent)) throw new Error(`unknown agent ${JSON.stringify(raw.agent)} (known: ${knownAgents.join(', ')})`);
  for (const key of ['session', 'transcriptRef']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') throw new Error(`${key} must be a non-empty string`);
  }
  for (const key of ['model', 'pane']) {
    if (!optionalString(raw[key])) throw new Error(`${key} must be a non-empty string or null`);
  }
  if (raw.turn !== undefined && raw.turn !== null && !(Number.isInteger(raw.turn) && raw.turn >= 0)) {
    throw new Error('turn must be an integer >= 0 or null');
  }
  if (raw.progressId !== undefined && raw.progressId !== null && !optionalString(raw.progressId)) {
    throw new Error('progressId must be a non-empty string or null');
  }
  const activityAliases = { 'handoff-triggered': 'idle-prompt-triggered', handoff: 'idle-prompt' };
  const legacyActivity = raw.activity === 'handoff-triggered' || raw.activity === 'handoff';
  const activity = activityAliases[raw.activity] ?? raw.activity ?? 'work';
  if (!['work', 'idle-prompt-triggered', 'idle-prompt'].includes(activity)) {
    throw new Error('activity must be "work", "idle-prompt-triggered" or "idle-prompt"');
  }
  if (raw.idlePromptId !== undefined && raw.handoffId !== undefined) {
    throw new Error('use only one of "idlePromptId" or legacy "handoffId"');
  }
  const idlePromptId = raw.idlePromptId ?? raw.handoffId;
  if ((activity === 'idle-prompt-triggered' || activity === 'idle-prompt') && (typeof idlePromptId !== 'string' || idlePromptId === '')) {
    throw new Error(legacyActivity ? 'handoffId is required for handoff events' : 'idlePromptId is required for idle prompt events');
  }
  if (typeof idlePromptId === 'string' && idlePromptId.length > 256) throw new Error('idlePromptId is too long');
  const event = {
    v: EVENT_VERSION,
    agent: raw.agent,
    session: raw.session,
    transcriptRef: raw.transcriptRef,
    model: raw.model ?? null,
    pane: raw.pane ?? null,
    turn: raw.turn ?? null,
  };
  if (raw.progressId !== undefined && raw.progressId !== null) event.progressId = raw.progressId;
  if (raw.activity !== undefined) event.activity = activity;
  if (idlePromptId !== undefined && idlePromptId !== null) {
    event.idlePromptId = idlePromptId;
    if (raw.handoffId !== undefined) event.handoffId = idlePromptId;
  }
  const feedbackRoute = validateFeedbackRoute(raw.feedbackRoute, event.session);
  if (feedbackRoute) event.feedbackRoute = feedbackRoute;
  if (raw.idleRoute !== undefined && raw.handoffRoute !== undefined) {
    throw new Error('use only one of "idleRoute" or legacy "handoffRoute"');
  }
  const idleRoute = validateIdleRoute(raw.idleRoute ?? raw.handoffRoute, event.session);
  if (idleRoute) {
    event.idleRoute = idleRoute;
    if (raw.handoffRoute !== undefined) event.handoffRoute = idleRoute;
  }
  return event;
}
