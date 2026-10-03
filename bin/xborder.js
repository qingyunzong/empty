#!/usr/bin/env node
import { runCli } from '../src/cli.js';

// Use exitCode (not process.exit) so buffered stderr writes are flushed.
process.exitCode = runCli(process.argv.slice(2));
