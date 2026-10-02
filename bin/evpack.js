#!/usr/bin/env node
import { run } from '../src/cli.js';

// Use exitCode rather than process.exit() so piped stdout is fully flushed.
process.exitCode = run(process.argv.slice(2));
