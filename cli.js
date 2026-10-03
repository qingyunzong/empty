#!/usr/bin/env node
import { runCli } from './lib/run.js';

process.exitCode = runCli(process.argv.slice(2));
