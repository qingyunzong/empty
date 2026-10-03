#!/usr/bin/env node
import { AlertStore, AlertError } from './store.js';

const EXIT = { OK: 0, USAGE: 1, ERROR: 2, E_GAP: 3, E_CRC: 4 };

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[key] = argv[++i];
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function usage() {
  console.error(`usage:
  alert-store append --dir D --device ID --seq N [--severity S] [--message M]
  alert-store replay --dir D [--cursor '{"dev":3}']
  alert-store verify --dir D
  alert-store index  --dir D
options: --chunk-size N --segment-chunks N --max-segments N`);
}

function storeOpts(opts) {
  const out = {};
  if (opts['chunk-size']) out.chunkSize = Number(opts['chunk-size']);
  if (opts['segment-chunks']) out.segmentChunks = Number(opts['segment-chunks']);
  if (opts['max-segments']) out.maxSegments = Number(opts['max-segments']);
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!cmd || !opts.dir) {
    usage();
    return EXIT.USAGE;
  }
  const store = await AlertStore.open(opts.dir, storeOpts(opts));
  switch (cmd) {
    case 'append': {
      if (opts.device === undefined || opts.seq === undefined) {
        usage();
        return EXIT.USAGE;
      }
      const rec = {
        device: String(opts.device),
        seq: Number(opts.seq),
        severity: opts.severity ?? 'info',
        message: opts.message ?? '',
      };
      const r = await store.append(rec);
      await store.close();
      console.log(JSON.stringify({ status: r.status, device: rec.device, seq: rec.seq }));
      return EXIT.OK;
    }
    case 'replay': {
      const cursor = opts.cursor ? JSON.parse(opts.cursor) : {};
      const res = await store.replay(cursor);
      await store.close();
      console.log(JSON.stringify({ alerts: res.alerts, cursor: res.cursor, gaps: res.gaps }));
      if (res.error) {
        for (const g of res.gaps) {
          console.error(`E_GAP: device ${g.device} expected seq ${g.expected} found ${g.found}`);
        }
        return EXIT.E_GAP;
      }
      return EXIT.OK;
    }
    case 'verify': {
      const v = await store.verify();
      await store.close();
      console.log(JSON.stringify({ ok: true, ...v }));
      return EXIT.OK;
    }
    case 'index': {
      console.log(JSON.stringify(store.buildIndex(), null, 2));
      await store.close();
      return EXIT.OK;
    }
    default:
      usage();
      return EXIT.USAGE;
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof AlertError || err?.code?.startsWith?.('E_')) {
    console.error(`${err.code}: ${err.message}`);
    if (err.code === 'E_CRC') process.exitCode = EXIT.E_CRC;
    else if (err.code === 'E_GAP') process.exitCode = EXIT.E_GAP;
    else process.exitCode = EXIT.ERROR;
  } else {
    console.error(err.stack ?? String(err));
    process.exitCode = EXIT.ERROR;
  }
}
