import crypto from 'node:crypto';
import { Empty, createInbox, headers, nanos } from '@nats-io/nats-core';
import { connect as connectNats } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { natsConnectionOptions, safeFeedbackErrorMessage } from './feedback.js';

export const HANDOFF_STREAM_NAME = 'AGENT_SIDECAR_HANDOFF';
export const HANDOFF_SUBJECT_PREFIX = 'agent-sidecar.handoff';
export const HANDOFF_STREAM_SUBJECTS = Object.freeze([
  `${HANDOFF_SUBJECT_PREFIX}.schedule.>`,
  `${HANDOFF_SUBJECT_PREFIX}.target.>`,
  `${HANDOFF_SUBJECT_PREFIX}.control.>`,
]);
export const HANDOFF_MAX_PAYLOAD_BYTES = 16 * 1024;
export const HANDOFF_MAX_PROMPT_BYTES = 8 * 1024;
export const HANDOFF_TIMEOUT_MS = 2000;
export const HANDOFF_CONSUMER_INACTIVE_MS = 5 * 60 * 1000;
export const HANDOFF_STREAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const HANDOFF_VERSION = 1;
const HANDOFF_TYPE = 'idle-handoff';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createHandoffRoute(session, { instanceId = crypto.randomUUID(), replySubject = createInbox() } = {}) {
  return {
    v: HANDOFF_VERSION,
    instanceId,
    replySubject,
    targetSubject: `${HANDOFF_SUBJECT_PREFIX}.target.${instanceId}`,
    scheduleSubject: `${HANDOFF_SUBJECT_PREFIX}.schedule.${instanceId}`,
    controlSubject: `${HANDOFF_SUBJECT_PREFIX}.control.${instanceId}`,
    session,
  };
}

export function handoffConsumerName(route) {
  return `sidecar_handoff_${route.instanceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`;
}

export function validateHandoffRoute(raw, session) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('handoffRoute must be an object');
  if (raw.v !== HANDOFF_VERSION) throw new Error(`unsupported handoffRoute version ${JSON.stringify(raw.v)} (expected ${HANDOFF_VERSION})`);
  for (const key of ['instanceId', 'replySubject', 'targetSubject', 'scheduleSubject', 'controlSubject', 'session']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') throw new Error(`handoffRoute.${key} must be a non-empty string`);
    if (raw[key].length > 256) throw new Error(`handoffRoute.${key} is too long`);
    if (/\s|[>*]/.test(raw[key])) throw new Error(`handoffRoute.${key} must be a concrete NATS subject`);
  }
  if (raw.session !== session) throw new Error('handoffRoute.session must match event.session');
  return {
    v: HANDOFF_VERSION,
    instanceId: raw.instanceId,
    replySubject: raw.replySubject,
    targetSubject: raw.targetSubject,
    scheduleSubject: raw.scheduleSubject,
    controlSubject: raw.controlSubject,
    session: raw.session,
  };
}

export function buildHandoffEnvelope({ event, plan, prompt, now = new Date() }) {
  const text = String(prompt ?? '').trim();
  if (text === '') throw new Error('idleHandoff.prompt must not be empty');
  if (Buffer.byteLength(text, 'utf8') > HANDOFF_MAX_PROMPT_BYTES) {
    throw new Error(`idleHandoff.prompt exceeds ${HANDOFF_MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  if (!event.handoffRoute) throw new Error('handoff route unavailable');
  const envelope = {
    v: HANDOFF_VERSION,
    type: HANDOFF_TYPE,
    // plan.id 在重试时保持不变，避免服务端 ACK 丢失后生成重复唤醒消息。
    id: plan.id,
    instanceId: event.handoffRoute.instanceId,
    agent: event.agent,
    session: event.session,
    planId: plan.id,
    workTurn: plan.work.turn,
    progressId: plan.work.progressId ?? null,
    createdAt: now.toISOString(),
    prompt: text,
  };
  const payload = JSON.stringify(envelope);
  if (Buffer.byteLength(payload, 'utf8') > HANDOFF_MAX_PAYLOAD_BYTES) {
    throw new Error(`idleHandoff payload exceeds ${HANDOFF_MAX_PAYLOAD_BYTES} UTF-8 bytes`);
  }
  return { envelope, payload: encoder.encode(payload) };
}

export function decodeHandoffMessage(data) {
  if (!data || data.byteLength > HANDOFF_MAX_PAYLOAD_BYTES) throw new Error('idleHandoff payload is too large');
  let value;
  try {
    value = JSON.parse(decoder.decode(data));
  } catch (err) {
    throw new Error(`invalid idleHandoff payload: ${err.message}`);
  }
  return validateHandoffEnvelope(value);
}

export function validateHandoffEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('idleHandoff payload must be an object');
  if (value.v !== HANDOFF_VERSION) throw new Error('unsupported idleHandoff version');
  if (value.type !== HANDOFF_TYPE) throw new Error('unsupported idleHandoff type');
  for (const key of ['id', 'instanceId', 'agent', 'session', 'planId', 'createdAt', 'prompt']) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') throw new Error(`idleHandoff.${key} must be a non-empty string`);
    if (value[key].length > 512) throw new Error(`idleHandoff.${key} is too long`);
  }
  if (!Number.isInteger(value.workTurn) || value.workTurn < 1) throw new Error('idleHandoff.workTurn must be a positive integer');
  if (value.progressId !== null && value.progressId !== undefined && (typeof value.progressId !== 'string' || value.progressId.length > 512)) {
    throw new Error('idleHandoff.progressId must be a string or null');
  }
  if (Buffer.byteLength(value.prompt, 'utf8') > HANDOFF_MAX_PROMPT_BYTES) throw new Error('idleHandoff.prompt is too large');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > HANDOFF_MAX_PAYLOAD_BYTES) throw new Error('idleHandoff payload is too large');
  if (Number.isNaN(Date.parse(value.createdAt))) throw new Error('idleHandoff.createdAt must be an ISO timestamp');
  return value;
}

export function emptyIdleHandoffState() {
  return {
    lastWork: null,
    lastCheck: null,
    inFlight: null,
    plan: null,
    scheduleError: null,
  };
}

export function planIdleHandoff({ state, event, config, now = new Date(), planId = crypto.randomUUID() }) {
  const next = structuredClone(state);
  const current = next.idleHandoff ??= emptyIdleHandoffState();
  if (config.idleHandoff?.enabled !== true || (event.activity ?? 'work') !== 'work') {
    return { state: next, action: null };
  }

  const turn = event.turn ?? 0;
  if (!Number.isInteger(turn) || turn < 1) return { state: next, action: null };
  const work = { turn, progressId: event.progressId ?? null };
  const sameAsLast = sameProgress(current.lastWork, work);
  const sameAsChecked = sameProgress(current.lastCheck?.work, work);
  const activePlan = current.plan && ['pending', 'scheduled', 'triggered'].includes(current.plan.status);
  const hasRoute = Boolean(event.handoffRoute);
  const planRouteMatches = !hasRoute || !current.plan || current.plan.route?.instanceId === event.handoffRoute.instanceId;

  if (sameAsChecked) {
    return { state: next, action: null };
  }
  if (sameAsLast && ['pending', 'error'].includes(current.plan?.status) && hasRoute && planRouteMatches) {
    current.plan.status = 'pending';
    return {
      state: next,
      action: { type: 'schedule', plan: current.plan, previousPlan: current.plan.previousPlan ?? null },
    };
  }
  if (sameAsLast && activePlan && planRouteMatches) {
    return { state: next, action: null };
  }
  const shouldCreate = !sameAsLast || !current.plan || current.plan.status === 'error' || (hasRoute && !planRouteMatches);
  current.lastWork = work;
  if (!shouldCreate || !hasRoute) {
    if (!hasRoute && !sameAsChecked) current.scheduleError = 'handoff route unavailable';
    return { state: next, action: null };
  }

  const previousPlan = current.plan && current.plan.status !== 'completed'
    ? { id: current.plan.id, route: current.plan.route }
    : null;
  const afterMs = config.idleHandoff.afterMs;
  const deadline = new Date(new Date(now).getTime() + afterMs);
  const plan = {
    id: planId,
    status: 'pending',
    work,
    deadline: deadline.toISOString(),
    createdAt: new Date(now).toISOString(),
    prompt: config.idleHandoff.prompt,
    route: {
      instanceId: event.handoffRoute.instanceId,
      targetSubject: event.handoffRoute.targetSubject,
      scheduleSubject: event.handoffRoute.scheduleSubject,
      controlSubject: event.handoffRoute.controlSubject,
    },
    previousPlan,
  };
  current.plan = plan;
  current.scheduleError = null;
  return { state: next, action: { type: 'schedule', plan, previousPlan } };
}

export function markIdleHandoffScheduled(state, planId, now = new Date()) {
  const next = structuredClone(state);
  const plan = next.idleHandoff?.plan;
  if (plan?.id === planId && plan.status === 'pending') {
    plan.status = 'scheduled';
    plan.scheduledAt = new Date(now).toISOString();
    next.idleHandoff.scheduleError = null;
  }
  return next;
}

export function markIdleHandoffScheduleFailed(state, planId, warning, now = new Date()) {
  const next = structuredClone(state);
  const plan = next.idleHandoff?.plan;
  if (plan?.id === planId) {
    // 发布结果可能未知：保留 pending 和原 plan id，让下一次事件用同一个 msgID 重试。
    plan.status = 'pending';
    plan.lastScheduleAttemptAt = new Date(now).toISOString();
    plan.scheduleAttempts = (plan.scheduleAttempts ?? 0) + 1;
    next.idleHandoff.scheduleError = warning;
  }
  return next;
}

export function markIdleHandoffTriggered(state, { planId, now = new Date() }) {
  const next = structuredClone(state);
  const current = next.idleHandoff ??= emptyIdleHandoffState();
  const plan = current.plan;
  if (!plan || plan.id !== planId) return { state: next, matched: false };
  if (plan.status === 'triggered' && current.inFlight?.id === planId) {
    return { state: next, matched: true };
  }
  const triggeredAt = new Date(now).toISOString();
  plan.status = 'triggered';
  plan.triggeredAt = triggeredAt;
  current.inFlight = { id: plan.id, work: plan.work, triggeredAt, documentWritten: null };
  return { state: next, matched: true };
}

export function completeIdleHandoff(state, { handoffId, now = new Date() }) {
  const next = structuredClone(state);
  const current = next.idleHandoff ??= emptyIdleHandoffState();
  const plan = current.plan;
  const inFlight = current.inFlight;
  if (inFlight && inFlight.id !== handoffId) return { state: next, matched: false };
  if (!inFlight && (!plan || plan.id !== handoffId)) return { state: next, matched: false };
  const check = {
    id: handoffId,
    work: inFlight?.work ?? plan.work,
    triggeredAt: inFlight?.triggeredAt ?? plan.triggeredAt ?? null,
    completedAt: new Date(now).toISOString(),
    documentWritten: null,
  };
  current.lastCheck = check;
  current.inFlight = null;
  if (current.plan?.id === handoffId) current.plan = null;
  current.scheduleError = null;
  return { state: next, matched: true, check };
}

export async function ensureHandoffStream(jsm) {
  const config = {
    name: HANDOFF_STREAM_NAME,
    subjects: [...HANDOFF_STREAM_SUBJECTS],
    storage: 'file',
    retention: 'limits',
    max_age: nanos(HANDOFF_STREAM_MAX_AGE_MS),
    allow_msg_schedules: true,
    allow_rollup_hdrs: true,
  };
  let info;
  try {
    info = await jsm.streams.info(HANDOFF_STREAM_NAME);
  } catch (infoError) {
    try {
      info = await jsm.streams.add(config);
    } catch (addError) {
      try {
        info = await jsm.streams.info(HANDOFF_STREAM_NAME);
      } catch {
        throw addError;
      }
    }
  }
  const subjects = info.config?.subjects ?? [];
  if (info.config?.allow_msg_schedules !== true || info.config?.allow_rollup_hdrs !== true || !HANDOFF_STREAM_SUBJECTS.every((subject) => subjects.some((pattern) => subjectMatches(pattern, subject)))) {
    throw new Error(`JetStream stream ${HANDOFF_STREAM_NAME} has incompatible scheduling settings`);
  }
  return info;
}

export async function ensureHandoffConsumer(jsm, route) {
  const name = handoffConsumerName(route);
  const expected = {
    name,
    ack_policy: 'none',
    deliver_policy: 'new',
    replay_policy: 'instant',
    deliver_subject: route.replySubject,
    filter_subject: route.targetSubject,
    inactive_threshold: nanos(HANDOFF_CONSUMER_INACTIVE_MS),
  };
  let info;
  try {
    info = await jsm.consumers.info(HANDOFF_STREAM_NAME, name);
  } catch (infoError) {
    try {
      info = await jsm.consumers.add(HANDOFF_STREAM_NAME, expected);
    } catch (addError) {
      try {
        info = await jsm.consumers.info(HANDOFF_STREAM_NAME, name);
      } catch {
        throw addError;
      }
    }
  }
  const actual = info.config ?? {};
  for (const key of ['deliver_subject', 'filter_subject', 'ack_policy']) {
    if (actual[key] !== expected[key]) throw new Error(`JetStream handoff consumer ${name} has incompatible ${key}`);
  }
  return { name, info };
}

export async function deleteHandoffConsumer(jsm, route) {
  if (!jsm || !route) return;
  try {
    await jsm.consumers.delete(HANDOFF_STREAM_NAME, handoffConsumerName(route));
  } catch {
    // 会话关闭采用尽力而为，消费者的 inactivity threshold 是兜底。
  }
}

export async function publishIdleHandoffPlan({ config, event, plan, previousPlan, now = new Date(), connect = connectNats, manager = jetstreamManager, jsFactory = jetstream, timeoutMs = HANDOFF_TIMEOUT_MS }) {
  if (!event.handoffRoute) return { scheduled: false, warning: 'handoff route unavailable' };
  let connection;
  try {
    const options = natsConnectionOptions(config.feedback.natsUrl, {
      name: 'agent-sidecar-handoff-worker',
      reconnect: false,
      maxReconnectAttempts: 0,
      waitOnFirstConnect: true,
      timeout: HANDOFF_TIMEOUT_MS,
    });
    connection = await withTimeout(connect(options), timeoutMs, 'connect');
    const jsm = await withTimeout(manager(connection), timeoutMs, 'JetStream manager');
    await withTimeout(ensureHandoffStream(jsm), timeoutMs, 'JetStream stream');
    const js = jsFactory(connection);

    if (previousPlan?.route?.scheduleSubject && previousPlan.route.controlSubject) {
      const cancelHeaders = headers();
      cancelHeaders.set('Nats-Schedule-Next', 'purge');
      cancelHeaders.set('Nats-Scheduler', previousPlan.route.scheduleSubject);
      await withTimeout(js.publish(previousPlan.route.controlSubject, Empty, {
        msgID: `agent-sidecar-handoff-cancel-${previousPlan.id}`,
        headers: cancelHeaders,
      }), timeoutMs, 'cancel');
    }

    const built = buildHandoffEnvelope({ event, plan, prompt: plan.prompt, now });
    await withTimeout(js.publish(plan.route.scheduleSubject, built.payload, {
      msgID: `agent-sidecar-handoff-${plan.id}`,
      schedule: { specification: new Date(plan.deadline), target: plan.route.targetSubject },
    }), timeoutMs, 'schedule');
    return { scheduled: true, warning: null };
  } catch (err) {
    return { scheduled: false, warning: `idle handoff scheduling failed: ${safeFeedbackErrorMessage(err)}` };
  } finally {
    if (connection) {
      try {
        await withTimeout(connection.close(), timeoutMs, 'close');
      } catch {
        // The short-lived worker is exiting; a close failure is already bounded.
      }
    }
  }
}

function sameProgress(a, b) {
  if (!a || !b) return false;
  if (a.progressId && b.progressId) return a.progressId === b.progressId && a.turn === b.turn;
  return a.turn === b.turn;
}

function subjectMatches(pattern, subject) {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '>') return i < s.length;
    if (i >= s.length || (p[i] !== '*' && p[i] !== s[i])) return false;
  }
  return p.length === s.length;
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`idle handoff ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
