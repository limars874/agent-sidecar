#!/usr/bin/env node
// Stands in for the herdr CLI: records its args.
import fs from 'node:fs';

if (process.env.FAKE_HERDR_LOG) fs.appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
