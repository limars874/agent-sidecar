import crypto from 'node:crypto';
import { createInbox } from '@nats-io/nats-core';
import { connect as connectNats } from '@nats-io/transport-node';

export const FEEDBACK_MAX_PAYLOAD_BYTES = 16 * 1024;
export const FEEDBACK_MAX_CONTENT_BYTES = 4 * 1024;
export const FEEDBACK_TIMEOUT_MS = 2000;

const FEEDBACK_VERSION = 1;
const FEEDBACK_TYPE = 'feedback';
const encoder = new TextEncoder();

export function createFeedbackRoute(session, { instanceId = crypto.randomUUID(), replySubject = createInbox() } = {}) {
  return { v: 1, instanceId, replySubject, session };
}

export function buildFeedbackEnvelope({ item, event, content, sourceTurn, now = new Date() }) {
  const text = String(content ?? '').trim();
  if (text === '') return null;
  const contentBytes = Buffer.byteLength(text, 'utf8');
  if (contentBytes > FEEDBACK_MAX_CONTENT_BYTES) {
    throw new Error(`feedback content exceeds ${FEEDBACK_MAX_CONTENT_BYTES} UTF-8 bytes`);
  }
  if (!event.feedbackRoute) throw new Error('feedback route unavailable');
  if (event.feedbackRoute.session !== event.session) throw new Error('feedback route session mismatch');

  const envelope = {
    v: FEEDBACK_VERSION,
    type: FEEDBACK_TYPE,
    id: crypto.randomUUID(),
    instanceId: event.feedbackRoute.instanceId,
    agent: event.agent,
    session: event.session,
    item: item.name,
    sourceTurn: Number.isInteger(sourceTurn) ? sourceTurn : event.turn ?? 0,
    createdAt: now.toISOString(),
    content: text,
  };
  const payload = JSON.stringify(envelope);
  if (Buffer.byteLength(payload, 'utf8') > FEEDBACK_MAX_PAYLOAD_BYTES) {
    throw new Error(`feedback payload exceeds ${FEEDBACK_MAX_PAYLOAD_BYTES} UTF-8 bytes`);
  }
  return { envelope, payload: encoder.encode(payload) };
}

export function validateFeedbackEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('feedback payload must be an object');
  if (value.v !== FEEDBACK_VERSION) throw new Error('unsupported feedback version');
  if (value.type !== FEEDBACK_TYPE) throw new Error('unsupported feedback type');
  for (const key of ['id', 'instanceId', 'agent', 'session', 'item', 'createdAt']) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new Error(`feedback.${key} must be a non-empty string`);
    if (value[key].length > 512) throw new Error(`feedback.${key} is too long`);
  }
  if (typeof value.content !== 'string' || value.content === '') throw new Error('feedback.content must be a non-empty string');
  if (!Number.isInteger(value.sourceTurn) || value.sourceTurn < 0) throw new Error('feedback.sourceTurn must be a non-negative integer');
  if (value.content.trim() === '') throw new Error('feedback.content must not be empty');
  if (Buffer.byteLength(value.content, 'utf8') > FEEDBACK_MAX_CONTENT_BYTES) throw new Error('feedback.content is too large');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > FEEDBACK_MAX_PAYLOAD_BYTES) throw new Error('feedback payload is too large');
  if (Number.isNaN(Date.parse(value.createdAt))) throw new Error('feedback.createdAt must be an ISO timestamp');
  return value;
}

export function natsConnectionOptions(natsUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(natsUrl);
  } catch (err) {
    throw new Error(`invalid feedback.natsUrl: ${err.message}`);
  }
  if (!['nats:', 'tls:'].includes(parsed.protocol) || parsed.hostname === '') {
    throw new Error('feedback.natsUrl must use nats:// or tls:// with a host');
  }
  const server = `${parsed.protocol}//${parsed.host}`;
  return {
    servers: server,
    ...(parsed.username !== '' ? { user: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password !== '' ? { pass: decodeURIComponent(parsed.password) } : {}),
    ...options,
  };
}

export async function publishFeedback({ item, event, content, sourceTurn, config, now, connect = connectNats }) {
  if (!item.feedback || String(content ?? '').trim() === '') return { published: false, warning: null };

  let built;
  try {
    built = buildFeedbackEnvelope({ item, event, content, sourceTurn, now });
  } catch (err) {
    return { published: false, warning: `feedback skipped: ${err.message}` };
  }

  let connection;
  try {
    const options = natsConnectionOptions(config.feedback.natsUrl, {
      name: 'agent-sidecar-feedback-worker',
      reconnect: false,
      maxReconnectAttempts: 0,
      waitOnFirstConnect: true,
      timeout: FEEDBACK_TIMEOUT_MS,
    });
    connection = await withTimeout(connect(options), FEEDBACK_TIMEOUT_MS, 'connect');
    connection.publish(event.feedbackRoute.replySubject, built.payload);
    await withTimeout(connection.flush(), FEEDBACK_TIMEOUT_MS, 'flush');
    return { published: true, warning: null, id: built.envelope.id };
  } catch (err) {
    return { published: false, warning: `feedback publish failed: ${safeFeedbackErrorMessage(err)}` };
  } finally {
    if (connection) {
      try {
        await withTimeout(connection.close(), FEEDBACK_TIMEOUT_MS, 'close');
      } catch {
        // The worker is exiting; a close failure cannot change the item result.
      }
    }
  }
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`feedback ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function safeFeedbackErrorMessage(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  return message.replace(/(nats|tls):\/\/[^\s]+/gi, '<nats-url>');
}
