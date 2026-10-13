// The shared event (CONTRACT.md "Event"). Every adapter reports a finished
// turn as one of these; nothing else crosses from an agent into the core.
import { validateHandoffRoute } from './idle-handoff.js';

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
  const activity = raw.activity ?? 'work';
  if (!['work', 'handoff-triggered', 'handoff'].includes(activity)) {
    throw new Error('activity must be "work", "handoff-triggered" or "handoff"');
  }
  if ((activity === 'handoff-triggered' || activity === 'handoff') && (typeof raw.handoffId !== 'string' || raw.handoffId === '')) {
    throw new Error('handoffId is required for handoff events');
  }
  if (typeof raw.handoffId === 'string' && raw.handoffId.length > 256) throw new Error('handoffId is too long');
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
  if (raw.handoffId !== undefined && raw.handoffId !== null) event.handoffId = raw.handoffId;
  const feedbackRoute = validateFeedbackRoute(raw.feedbackRoute, event.session);
  if (feedbackRoute) event.feedbackRoute = feedbackRoute;
  const handoffRoute = validateHandoffRoute(raw.handoffRoute, event.session);
  if (handoffRoute) event.handoffRoute = handoffRoute;
  return event;
}
