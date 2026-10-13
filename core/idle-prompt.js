import crypto from 'node:crypto';
import { Empty, createInbox, headers, nanos } from '@nats-io/nats-core';
import { connect as connectNats } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { natsConnectionOptions, safeFeedbackErrorMessage } from './feedback.js';

// The stream and subject prefix retain their published transport names for a safe migration.
export const IDLE_STREAM_NAME = 'AGENT_SIDECAR_HANDOFF';
export const IDLE_SUBJECT_PREFIX = 'agent-sidecar.handoff';
export const IDLE_STREAM_SUBJECTS = Object.freeze([
  `${IDLE_SUBJECT_PREFIX}.schedule.>`,
  `${IDLE_SUBJECT_PREFIX}.target.>`,
  `${IDLE_SUBJECT_PREFIX}.control.>`,
]);
export const IDLE_MAX_PAYLOAD_BYTES = 16 * 1024;
export const IDLE_MAX_PROMPT_BYTES = 8 * 1024;
export const IDLE_TIMEOUT_MS = 2000;
export const IDLE_CONSUMER_INACTIVE_MS = 5 * 60 * 1000;
export const IDLE_STREAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const IDLE_VERSION = 1;
const IDLE_TYPE = 'idle-prompt';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createIdleRoute(session, { instanceId = crypto.randomUUID(), replySubject = createInbox() } = {}) {
  return {
    v: IDLE_VERSION,
    instanceId,
    replySubject,
    targetSubject: `${IDLE_SUBJECT_PREFIX}.target.${instanceId}`,
    scheduleSubject: `${IDLE_SUBJECT_PREFIX}.schedule.${instanceId}`,
    controlSubject: `${IDLE_SUBJECT_PREFIX}.control.${instanceId}`,
    session,
  };
}

export function idleConsumerName(route) {
  return `sidecar_idle_${route.instanceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`;
}

export function validateIdleRoute(raw, session) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('idleRoute must be an object');
  if (raw.v !== IDLE_VERSION) throw new Error(`unsupported idleRoute version ${JSON.stringify(raw.v)} (expected ${IDLE_VERSION})`);
  for (const key of ['instanceId', 'replySubject', 'targetSubject', 'scheduleSubject', 'controlSubject', 'session']) {
    if (typeof raw[key] !== 'string' || raw[key] === '') throw new Error(`idleRoute.${key} must be a non-empty string`);
    if (raw[key].length > 256) throw new Error(`idleRoute.${key} is too long`);
    if (/\s|[>*]/.test(raw[key])) throw new Error(`idleRoute.${key} must be a concrete NATS subject`);
  }
  if (raw.session !== session) throw new Error('idleRoute.session must match event.session');
  return {
    v: IDLE_VERSION,
    instanceId: raw.instanceId,
    replySubject: raw.replySubject,
    targetSubject: raw.targetSubject,
    scheduleSubject: raw.scheduleSubject,
    controlSubject: raw.controlSubject,
    session: raw.session,
  };
}

function planScheduleSubject(route, planId) {
  const suffix = String(planId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${route.scheduleSubject}.plan.${suffix}`;
}

export function buildIdlePromptEnvelope({ event, plan, prompt, now = new Date() }) {
  const text = String(prompt ?? '');
  if (text.trim() === '') throw new Error('idle.prompt must not be empty');
  if (Buffer.byteLength(text, 'utf8') > IDLE_MAX_PROMPT_BYTES) {
    throw new Error(`idle.prompt exceeds ${IDLE_MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  if (!event.idleRoute) throw new Error('idle route unavailable');
  const envelope = {
    v: IDLE_VERSION,
    type: IDLE_TYPE,
    // plan.id 在重试时保持不变，避免服务端 ACK 丢失后生成重复唤醒消息。
    id: plan.id,
    instanceId: event.idleRoute.instanceId,
    agent: event.agent,
    session: event.session,
    planId: plan.id,
    workTurn: plan.work.turn,
    progressId: plan.work.progressId ?? null,
    createdAt: now.toISOString(),
    prompt: text,
  };
  const payload = JSON.stringify(envelope);
  if (Buffer.byteLength(payload, 'utf8') > IDLE_MAX_PAYLOAD_BYTES) {
    throw new Error(`idle prompt payload exceeds ${IDLE_MAX_PAYLOAD_BYTES} UTF-8 bytes`);
  }
  return { envelope, payload: encoder.encode(payload) };
}

export function decodeIdlePromptMessage(data) {
  if (!data || data.byteLength > IDLE_MAX_PAYLOAD_BYTES) throw new Error('idle prompt payload is too large');
  let value;
  try {
    value = JSON.parse(decoder.decode(data));
  } catch (err) {
    throw new Error(`invalid idle prompt payload: ${err.message}`);
  }
  return validateIdlePromptEnvelope(value);
}

export function validateIdlePromptEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('idle prompt payload must be an object');
  if (value.v !== IDLE_VERSION) throw new Error('unsupported idle prompt version');
  if (value.type !== IDLE_TYPE) throw new Error('unsupported idle prompt type');
  for (const key of ['id', 'instanceId', 'agent', 'session', 'planId', 'createdAt', 'prompt']) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') throw new Error(`idle.${key} must be a non-empty string`);
    if (value[key].length > 512) throw new Error(`idle.${key} is too long`);
  }
  if (!Number.isInteger(value.workTurn) || value.workTurn < 1) throw new Error('idle.workTurn must be a positive integer');
  if (value.progressId !== null && value.progressId !== undefined && (typeof value.progressId !== 'string' || value.progressId.length > 512)) {
    throw new Error('idle.progressId must be a string or null');
  }
  if (Buffer.byteLength(value.prompt, 'utf8') > IDLE_MAX_PROMPT_BYTES) throw new Error('idle.prompt is too large');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > IDLE_MAX_PAYLOAD_BYTES) throw new Error('idle prompt payload is too large');
  if (Number.isNaN(Date.parse(value.createdAt))) throw new Error('idle.createdAt must be an ISO timestamp');
  return value;
}

export function emptyIdlePromptState() {
  return {
    lastWork: null,
    lastCheck: null,
    inFlight: null,
    plan: null,
    scheduleError: null,
  };
}

function cloneState(state) {
  return structuredClone(state ?? {});
}

export function planIdlePrompt({ state, event, config, now = new Date(), planId = crypto.randomUUID() }) {
  const next = cloneState(state);
  if (config.idle?.enabled !== true || (event.activity ?? 'work') !== 'work') {
    return { state: next, action: null };
  }
  const current = (next.idle ??= emptyIdlePromptState());

  const turn = event.turn ?? 0;
  if (!Number.isInteger(turn) || turn < 1) return { state: next, action: null };
  const work = { turn, progressId: event.progressId ?? null };
  const sameAsLast = sameProgress(current.lastWork, work);
  const sameAsChecked = sameProgress(current.lastCheck?.work, work);
  const activePlan = current.plan && ['pending', 'scheduled', 'triggered'].includes(current.plan.status);
  const hasRoute = Boolean(event.idleRoute);
  const planRouteMatches = !hasRoute || !current.plan || current.plan.route?.instanceId === event.idleRoute.instanceId;

  if (sameAsChecked) {
    return { state: next, action: null };
  }
  if (sameAsLast && current.plan?.status === 'pending' && hasRoute && planRouteMatches) {
    current.plan.status = 'pending';
    return {
      state: next,
      action: { type: 'schedule', plan: current.plan, previousPlan: current.plan.previousPlan ?? null },
    };
  }
  if (sameAsLast && activePlan && planRouteMatches) {
    return { state: next, action: null };
  }
  const shouldCreate = !sameAsLast || !current.plan || (hasRoute && !planRouteMatches);
  current.lastWork = work;
  if (!shouldCreate || !hasRoute) {
    if (!hasRoute && !sameAsChecked) current.scheduleError = 'idle route unavailable';
    return { state: next, action: null };
  }

  const previousPlan = current.plan && current.plan.status !== 'completed'
    ? { id: current.plan.id, route: current.plan.route }
    : null;
  const afterMs = config.idle.afterMs;
  const deadline = new Date(new Date(now).getTime() + afterMs);
  const plan = {
    id: planId,
    status: 'pending',
    work,
    deadline: deadline.toISOString(),
    createdAt: new Date(now).toISOString(),
    prompt: config.idle.prompt,
    route: {
      instanceId: event.idleRoute.instanceId,
      targetSubject: event.idleRoute.targetSubject,
      scheduleSubject: planScheduleSubject(event.idleRoute, planId),
      controlSubject: event.idleRoute.controlSubject,
    },
    previousPlan,
  };
  current.plan = plan;
  current.scheduleError = null;
  return { state: next, action: { type: 'schedule', plan, previousPlan } };
}

export function markIdlePromptScheduled(state, planId, now = new Date()) {
  const next = cloneState(state);
  const current = (next.idle ??= emptyIdlePromptState());
  const plan = current.plan;
  if (plan?.id === planId && plan.status === 'pending') {
    plan.status = 'scheduled';
    plan.scheduledAt = new Date(now).toISOString();
    current.scheduleError = null;
  }
  return next;
}

export function markIdlePromptScheduleFailed(state, planId, warning, now = new Date()) {
  const next = cloneState(state);
  const current = (next.idle ??= emptyIdlePromptState());
  const plan = current.plan;
  if (plan?.id === planId) {
    // 发布结果可能未知：保留 pending 和原 plan id，让下一次事件用同一个 msgID 重试。
    plan.status = 'pending';
    plan.lastScheduleAttemptAt = new Date(now).toISOString();
    plan.scheduleAttempts = (plan.scheduleAttempts ?? 0) + 1;
    current.scheduleError = warning;
  }
  return next;
}

export function markIdlePromptTriggered(state, { idlePromptId, now = new Date() }) {
  const next = cloneState(state);
  const current = (next.idle ??= emptyIdlePromptState());
  const planId = idlePromptId;
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

export function completeIdlePrompt(state, { idlePromptId, now = new Date() }) {
  const next = cloneState(state);
  const current = (next.idle ??= emptyIdlePromptState());
  const plan = current.plan;
  const inFlight = current.inFlight;
  const planId = idlePromptId;
  if (inFlight && inFlight.id !== planId) return { state: next, matched: false };
  if (!inFlight && (!plan || plan.id !== planId)) return { state: next, matched: false };
  const check = {
    id: planId,
    work: inFlight?.work ?? plan.work,
    triggeredAt: inFlight?.triggeredAt ?? plan.triggeredAt ?? null,
    completedAt: new Date(now).toISOString(),
    documentWritten: null,
  };
  current.lastCheck = check;
  current.inFlight = null;
  if (current.plan?.id === planId) current.plan = null;
  current.scheduleError = null;
  return { state: next, matched: true, check };
}

export async function ensureIdleStream(jsm) {
  const config = {
    name: IDLE_STREAM_NAME,
    subjects: [...IDLE_STREAM_SUBJECTS],
    storage: 'file',
    retention: 'limits',
    max_age: nanos(IDLE_STREAM_MAX_AGE_MS),
    allow_msg_schedules: true,
    allow_rollup_hdrs: true,
  };
  let info;
  try {
    info = await jsm.streams.info(IDLE_STREAM_NAME);
  } catch (infoError) {
    try {
      info = await jsm.streams.add(config);
    } catch (addError) {
      try {
        info = await jsm.streams.info(IDLE_STREAM_NAME);
      } catch {
        throw addError;
      }
    }
  }
  const subjects = info.config?.subjects ?? [];
  if (info.config?.allow_msg_schedules !== true || info.config?.allow_rollup_hdrs !== true || !IDLE_STREAM_SUBJECTS.every((subject) => subjects.some((pattern) => subjectMatches(pattern, subject)))) {
    throw new Error(`JetStream stream ${IDLE_STREAM_NAME} has incompatible scheduling settings`);
  }
  return info;
}

export async function ensureIdleConsumer(jsm, route) {
  const name = idleConsumerName(route);
  const expected = {
    name,
    ack_policy: 'none',
    deliver_policy: 'new',
    replay_policy: 'instant',
    deliver_subject: route.replySubject,
    filter_subject: route.targetSubject,
    inactive_threshold: nanos(IDLE_CONSUMER_INACTIVE_MS),
  };
  let info;
  try {
    info = await jsm.consumers.info(IDLE_STREAM_NAME, name);
  } catch (infoError) {
    try {
      info = await jsm.consumers.add(IDLE_STREAM_NAME, expected);
    } catch (addError) {
      try {
        info = await jsm.consumers.info(IDLE_STREAM_NAME, name);
      } catch {
        throw addError;
      }
    }
  }
  const actual = info.config ?? {};
  for (const key of ['deliver_subject', 'filter_subject', 'ack_policy']) {
    if (actual[key] !== expected[key]) throw new Error(`JetStream idle consumer ${name} has incompatible ${key}`);
  }
  return { name, info };
}

export async function deleteIdleConsumer(jsm, route) {
  if (!jsm || !route) return;
  try {
    await jsm.consumers.delete(IDLE_STREAM_NAME, idleConsumerName(route));
  } catch {
    // 会话关闭采用尽力而为，消费者的 inactivity threshold 是兜底。
  }
}

export async function publishIdlePromptPlan({ config, event, plan, previousPlan, now = new Date(), connect = connectNats, manager = jetstreamManager, jsFactory = jetstream, timeoutMs = IDLE_TIMEOUT_MS }) {
  if (!event.idleRoute) return { scheduled: false, warning: 'idle route unavailable' };
  let connection;
  try {
    const options = natsConnectionOptions(config.feedback.natsUrl, {
      name: 'agent-sidecar-idle-prompt-worker',
      reconnect: false,
      maxReconnectAttempts: 0,
      waitOnFirstConnect: true,
      timeout: IDLE_TIMEOUT_MS,
    });
    connection = await withTimeout(connect(options), timeoutMs, 'connect');
    const jsm = await withTimeout(manager(connection), timeoutMs, 'JetStream manager');
    await withTimeout(ensureIdleStream(jsm), timeoutMs, 'JetStream stream');
    const js = jsFactory(connection);

    if (previousPlan?.route?.scheduleSubject && previousPlan.route.controlSubject) {
      const cancelHeaders = headers();
      cancelHeaders.set('Nats-Schedule-Next', 'purge');
      cancelHeaders.set('Nats-Scheduler', previousPlan.route.scheduleSubject);
      await withTimeout(js.publish(previousPlan.route.controlSubject, Empty, {
        msgID: `agent-sidecar-idle-cancel-${previousPlan.id}`,
        headers: cancelHeaders,
      }), timeoutMs, 'cancel');
    }

    const built = buildIdlePromptEnvelope({ event, plan, prompt: plan.prompt, now });
    await withTimeout(js.publish(plan.route.scheduleSubject, built.payload, {
      msgID: `agent-sidecar-idle-${plan.id}`,
      schedule: { specification: new Date(plan.deadline), target: plan.route.targetSubject },
    }), timeoutMs, 'schedule');
    return { scheduled: true, warning: null };
  } catch (err) {
    return { scheduled: false, warning: `idle prompt scheduling failed: ${safeFeedbackErrorMessage(err)}` };
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
    timer = setTimeout(() => reject(new Error(`idle prompt ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
