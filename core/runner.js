// 基于 transcript 的区间运行一个 item：prompt 交给注入的 model runner，script 直接执行，最后处理输出。
import { spawnSync } from 'node:child_process';
import { applyOutput } from './outputs.js';
import { renderTranscript, sliceTurns } from './transcript.js';

// 模型优先级：item model → global model → 当前 session model。
export function resolveModel(item, config, event) {
  return item.model ?? config.model ?? event.model ?? null;
}

// effort 优先级：item effort → global effort；没有显式配置时交给 runner 处理默认值。
export function resolveEffort(item, config) {
  return item.effort ?? config.effort ?? null;
}

export function fillPrompt(prompt, vars) {
  const filled = prompt.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
  return prompt.includes('{{transcript}}') ? filled : `${filled}\n\n<transcript>\n${vars.transcript}\n</transcript>`;
}

// ctx: { item, runner, transcript, event, config, root, sessionDir, fromTurn, toTurn, env, now, dryRun }
// 返回 { model, prompt?, text?, output? }。
export function runItem(ctx) {
  const { item, runner, transcript, event, config, fromTurn, toTurn } = ctx;
  const model = resolveModel(item, config, event);
  const effort = resolveEffort(item, config);
  const rendered = renderTranscript(sliceTurns(transcript.messages, fromTurn, toTurn), {
    maxChars: config.maxTranscriptChars,
    toolResultLines: config.toolResultLines,
  });
  const vars = {
    transcript: rendered,
    agent: event.agent,
    session: event.session,
    item: item.name,
    turn: toTurn,
    fromTurn,
    toTurn,
    cwd: transcript.cwd ?? '',
    runner: runner?.name ?? null,
    effort,
  };

  if (item.kind === 'prompt') {
    if (!model) throw new Error('no model: set one on the item, in config, or report the session model in the event');
    const prompt = fillPrompt(item.prompt, vars);
    if (ctx.dryRun) return { model, effort, prompt };
    if (!runner || typeof runner.callModel !== 'function') throw new Error('no model runner configured');
    const text = runner.callModel({ model, effort, prompt, timeoutMs: config.timeoutMs, env: ctx.env });
    return { model, effort, text, output: applyOutput(item.output, text, ctx) };
  }

  const input = JSON.stringify({ ...vars, model, event, root: ctx.root });
  if (ctx.dryRun) return { model, effort, prompt: `$ ${item.script}\n<stdin>\n${input}` };
  const text = runScript(item, input, config.timeoutMs, ctx.env);
  return { model, effort, text, output: applyOutput(item.output, text, ctx) };
}

function runScript(item, input, timeoutMs, env) {
  const r = spawnSync('/bin/sh', ['-c', item.script], {
    cwd: item.dir,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`script failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`script exited ${r.status}: ${tail(r.stderr)}`);
  return r.stdout;
}

export function tail(text, max = 500) {
  const t = (text ?? '').trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}
