#!/usr/bin/env node
// agent-sidecar CLI. Commands and exit codes: README.md, CONTRACT.md "CLI".
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { handleEvent, listItems, runManual, work } from '../host/commands.js';
import { rootDir } from '../core/paths.js';

const USAGE = `Usage:
  agent-sidecar event [--json <event>] [--foreground]   report a finished turn (event JSON on stdin if --json is absent)
  agent-sidecar run <item> --agent <name> --session <file> [--model <m>] [--pane <id>]
                    [--from-turn <n>] [--to-turn <n>] [--dry-run]
  agent-sidecar items                                    list items and item errors
  agent-sidecar work <job-file>                          (internal) run a scheduled job

Storage root: $AGENT_SIDECAR_HOME, default ~/.agent-sidecar`;

class UsageError extends Error {}

function parse(args, options, positionals) {
  try {
    const r = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (r.positionals.length !== positionals) throw new UsageError(`expected ${positionals} argument(s)`);
    return r;
  } catch (err) {
    throw err instanceof UsageError ? err : new UsageError(err.message);
  }
}

function turnOption(value, flag) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a non-negative integer`);
  return Number(value);
}

function print(value) {
  process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
}

function main(argv, env = process.env) {
  const [command, ...args] = argv;
  const root = rootDir(env);
  try {
    switch (command) {
      case 'event': {
        const { values } = parse(args, { json: { type: 'string' }, foreground: { type: 'boolean' } }, 0);
        const text = values.json ?? fs.readFileSync(0, 'utf8');
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          throw new Error(`event is not valid JSON: ${err.message}`);
        }
        print(handleEvent(raw, { root, env, foreground: values.foreground }));
        return 0;
      }
      case 'run': {
        const { values, positionals } = parse(
          args,
          {
            agent: { type: 'string' },
            session: { type: 'string' },
            model: { type: 'string' },
            pane: { type: 'string' },
            'from-turn': { type: 'string' },
            'to-turn': { type: 'string' },
            'dry-run': { type: 'boolean' },
          },
          1,
        );
        if (!values.agent || !values.session) throw new UsageError('run needs --agent and --session');
        const r = runManual({
          name: positionals[0],
          agent: values.agent,
          sessionFile: path.resolve(values.session),
          model: values.model,
          pane: values.pane,
          fromTurn: turnOption(values['from-turn'], '--from-turn'),
          toTurn: turnOption(values['to-turn'], '--to-turn'),
          dryRun: values['dry-run'],
          root,
          env,
        });
        print(r);
        return 0;
      }
      case 'items': {
        parse(args, {}, 0);
        const { items, errors } = listItems({ root });
        for (const i of items) {
          print({ name: i.name, everyTurns: i.everyTurns, kind: i.kind, runner: i.runner, model: i.model, effort: i.effort, context: i.context, output: i.output, file: i.file });
        }
        for (const e of errors) process.stderr.write(`agent-sidecar: ${e.file}: ${e.message}\n`);
        return errors.length ? 1 : 0;
      }
      case 'work': {
        const { positionals } = parse(args, {}, 1);
        print(work(path.resolve(positionals[0]), { root, env }));
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        print(USAGE);
        return command === undefined ? 64 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    process.stderr.write(`agent-sidecar: ${err.message}\n`);
    if (err instanceof UsageError) {
      process.stderr.write(`${USAGE}\n`);
      return 64;
    }
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
