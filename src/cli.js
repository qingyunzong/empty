#!/usr/bin/env node
import { main } from './cli-main.js';

process.exit(main(process.argv.slice(2)));
