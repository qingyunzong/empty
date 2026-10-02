#!/usr/bin/env node
import { main } from '../src/cli.js';

// Set exitCode instead of calling process.exit(): the latter can truncate
// buffered stdout when it is a pipe.
process.exitCode = main(process.argv.slice(2));
