#!/usr/bin/env node
import { runCLI } from '../src/cli.js';

const code = await runCLI(process.argv.slice(2));
process.exit(code);
