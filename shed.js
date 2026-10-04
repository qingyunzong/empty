#!/usr/bin/env node
// Usage: shed model.json --gap 120 --budget 300
// Exit codes: 0 = optimal plan, 1 = infeasible (conflict reported),
//             2 = validation/usage error, 3 = unknown (budget exhausted)

import { run } from './src/cli.js';

process.exit(run(process.argv.slice(2), {}));
