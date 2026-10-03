#!/usr/bin/env node
import { runMain } from './app.js';

process.exitCode = runMain(process.argv.slice(2));
