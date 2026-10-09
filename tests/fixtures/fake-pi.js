#!/usr/bin/env node
// Stands in for `pi -p`: records its args, prompt and env, prints FAKE_PI_REPLY.
import fs from 'node:fs';

const prompt = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_PI_LOG) {
  fs.appendFileSync(
    process.env.FAKE_PI_LOG,
    `${JSON.stringify({ args: process.argv.slice(2), prompt, child: process.env.AGENT_SIDECAR_CHILD ?? null })}\n`,
  );
}
if (process.env.FAKE_PI_EXIT) {
  process.stderr.write('fake pi failure\n');
  process.exit(Number(process.env.FAKE_PI_EXIT));
}
process.stdout.write(`${process.env.FAKE_PI_REPLY ?? 'Fake reply'}\n`);
