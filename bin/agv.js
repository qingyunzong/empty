#!/usr/bin/env node
import { readdirSync, readFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseJsonl } from '../src/parse.js';
import {
  runEngine,
  DEFAULT_WINDOW_MS,
  DEFAULT_WATERMARK_LAG_MS,
} from '../src/engine.js';
import { AgvError } from '../src/errors.js';

function usage() {
  writeSync(2, 'usage: agv deadlock --in <dir> --out <dir> [--window-ms N] [--watermark-ms N]\n');
}

function parseArgs(argv) {
  if (argv[0] !== 'deadlock') return null;
  const opts = { windowMs: DEFAULT_WINDOW_MS, watermarkLagMs: DEFAULT_WATERMARK_LAG_MS };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--in' && value) opts.inDir = value;
    else if (flag === '--out' && value) opts.outDir = value;
    else if (flag === '--window-ms' && value) opts.windowMs = Number(value);
    else if (flag === '--watermark-ms' && value) opts.watermarkLagMs = Number(value);
    else return null;
    i += 1;
  }
  if (!opts.inDir || !opts.outDir) return null;
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) return null;
  if (!Number.isFinite(opts.watermarkLagMs) || opts.watermarkLagMs < 0) return null;
  return opts;
}

function writeLines(filePath, lines) {
  writeFileSync(filePath, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    usage();
    process.exit(2);
  }

  let files;
  try {
    files = readdirSync(opts.inDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  } catch (err) {
    writeSync(2, `ERROR IO cannot read input dir ${opts.inDir}: ${err.message}\n`);
    process.exit(2);
  }

  const events = [];
  try {
    for (const name of files) {
      const text = readFileSync(path.join(opts.inDir, name), 'utf8');
      events.push(...parseJsonl(text, name));
    }
    const result = runEngine(events, {
      windowMs: opts.windowMs,
      watermarkLagMs: opts.watermarkLagMs,
    });

    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(
      path.join(opts.outDir, 'cycles.json'),
      `${JSON.stringify(
        {
          windowMs: opts.windowMs,
          watermarkLagMs: opts.watermarkLagMs,
          cycleCount: result.cycles.length,
          cycles: result.cycles,
        },
        null,
        2,
      )}\n`,
    );
    writeLines(
      path.join(opts.outDir, 'waits.jsonl'),
      result.waits.map((w) => JSON.stringify(w)),
    );
    writeLines(
      path.join(opts.outDir, 'invalid.jsonl'),
      result.invalidated.map((c) => JSON.stringify(c)),
    );
    writeLines(
      path.join(opts.outDir, 'late.log'),
      result.late.map(
        (l) =>
          `LATE eventTs=${l.eventTs} watermark=${l.watermark} op=${l.op} where=${l.where} event=${JSON.stringify(l.event)}`,
      ),
    );

    writeSync(
      1,
      `processed ${events.length} events: ${result.cycles.length} active cycle(s), ` +
        `${result.invalidated.length} invalidated, ${result.waits.length} wait edge(s), ` +
        `${result.late.length} late event(s)\n`,
    );
  } catch (err) {
    if (err instanceof AgvError) {
      writeSync(2, `ERROR ${err.code} ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

main();
