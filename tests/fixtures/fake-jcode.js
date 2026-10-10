#!/usr/bin/env node
// 模拟 `jcode run --json`：记录参数并返回机器可读的 text。
import fs from 'node:fs';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const prompt = separator >= 0 ? args.slice(separator + 1).join(' ') : args.at(-1) ?? '';
if (process.env.FAKE_JCODE_LOG) {
  fs.appendFileSync(process.env.FAKE_JCODE_LOG, `${JSON.stringify({ args, prompt })}\n`);
}
if (process.env.FAKE_JCODE_EXIT) {
  process.stderr.write('fake jcode failure\n');
  process.exit(Number(process.env.FAKE_JCODE_EXIT));
}
process.stdout.write(`${JSON.stringify({ session_id: 'fake-jcode-session', provider: 'openai', model: 'fake-model', text: process.env.FAKE_JCODE_REPLY ?? 'Fake jcode reply', usage: {} })}\n`);
