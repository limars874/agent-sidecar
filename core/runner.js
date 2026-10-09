// Runs one item over a slice of the transcript: prompt (through the adapter's
// model call) or script, then its output.
import { spawnSync } from 'node:child_process';
import { applyOutput } from './outputs.js';
import { renderTranscript, sliceTurns } from './transcript.js';

// Item model, then the global model, then the session's current model.
export function resolveModel(item, config, event) {
  return item.model ?? config.model ?? event.model ?? null;
}

export function fillPrompt(prompt, vars) {
  const filled = prompt.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
  return prompt.includes('{{transcript}}') ? filled : `${filled}\n\n<transcript>\n${vars.transcript}\n</transcript>`;
}

// ctx: { item, adapter, transcript, event, config, root, sessionDir, fromTurn, toTurn, env, now, dryRun }
// Returns { model, prompt?, text?, output? }.
export function runItem(ctx) {
  const { item, adapter, transcript, event, config, fromTurn, toTurn } = ctx;
  const model = resolveModel(item, config, event);
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
  };

  if (item.kind === 'prompt') {
    if (!model) throw new Error('no model: set one on the item, in config, or report the session model in the event');
    const prompt = fillPrompt(item.prompt, vars);
    if (ctx.dryRun) return { model, prompt };
    const text = adapter.callModel({ model, prompt, timeoutMs: config.timeoutMs, env: ctx.env });
    return { model, text, output: applyOutput(item.output, text, ctx) };
  }

  const input = JSON.stringify({ ...vars, model, event, root: ctx.root });
  if (ctx.dryRun) return { model, prompt: `$ ${item.script}\n<stdin>\n${input}` };
  const text = runScript(item, input, config.timeoutMs, ctx.env);
  return { model, text, output: applyOutput(item.output, text, ctx) };
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
