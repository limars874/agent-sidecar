// The shared event (CONTRACT.md "Event"). Every adapter reports a finished
// turn as one of these; nothing else crosses from an agent into the core.
export const EVENT_VERSION = 1;

const optionalString = (v) => v === undefined || v === null || (typeof v === 'string' && v !== '');

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
  return {
    v: EVENT_VERSION,
    agent: raw.agent,
    session: raw.session,
    transcriptRef: raw.transcriptRef,
    model: raw.model ?? null,
    pane: raw.pane ?? null,
    turn: raw.turn ?? null,
  };
}
