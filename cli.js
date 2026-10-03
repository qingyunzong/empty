#!/usr/bin/env node
import { runCommand } from './src/commands.js';

const { out, code } = runCommand(process.argv.slice(2));
if (code === 0) console.log(JSON.stringify(out, null, 2));
else console.error(JSON.stringify(out, null, 2));
process.exitCode = code;
