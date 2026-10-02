#!/usr/bin/env node
import { main } from '../src/cli.js';

// Set exitCode instead of process.exit() so piped stdout is fully flushed.
process.exitCode = main(process.argv.slice(2));
