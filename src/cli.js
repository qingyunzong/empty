#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Graph } from './graph.js';
import { encodeGraph, decodeIncremental, getNode } from './format.js';
import { findBestPath, RouteError } from './scheduler.js';
import { Store, ConflictError } from './store.js';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_ROUTE_ERROR = 2;
export const EXIT_CONFLICT = 3;
export const EXIT_CORRUPT = 4;

const USAGE = `usage:
  route init <storeDir>
  route build <graph.json> <out.bin> [--chunk-size N]
  route query <file.bin> <start> <end>
  route node <file.bin> <nodeId>
  route verify <file.bin>
  route commit <storeDir> <baseHash|-> <graph.json> --read a,b --write a,b [--chunk-size N]
  route log <storeDir>`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function loadGraphJson(file) {
  return Graph.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'init': {
        const [dir] = rest;
        if (!dir) return usage();
        Store.init(dir);
        console.log(`initialized store at ${dir}`);
        return EXIT_OK;
      }
      case 'build': {
        const { flags, rest: pos } = parseFlags(rest);
        const [graphFile, outFile] = pos;
        if (!graphFile || !outFile) return usage();
        const chunkSize = flags['chunk-size'] ? Number(flags['chunk-size']) : 8;
        const buffer = encodeGraph(loadGraphJson(graphFile), { chunkSize });
        fs.writeFileSync(outFile, buffer);
        console.log(`wrote ${outFile} (${buffer.length} bytes)`);
        return EXIT_OK;
      }
      case 'query': {
        const [file, start, end] = rest;
        if (!file || !start || !end) return usage();
        const result = decodeIncremental(fs.readFileSync(file));
        if (result.corruptedAt !== null) {
          console.error(`W_CORRUPT block=${result.corruptedAt}`);
        } else if (result.truncated) {
          console.error('W_CORRUPT truncated');
        }
        const best = findBestPath(result.graph, start, end);
        console.log(JSON.stringify({ path: best.path, time: best.time }));
        return EXIT_OK;
      }
      case 'node': {
        const [file, nodeId] = rest;
        if (!file || !nodeId) return usage();
        const rec = getNode(fs.readFileSync(file), nodeId);
        if (!rec) {
          console.error('E_UNKNOWN_NODE');
          return EXIT_ROUTE_ERROR;
        }
        console.log(JSON.stringify(rec));
        return EXIT_OK;
      }
      case 'verify': {
        const [file] = rest;
        if (!file) return usage();
        const result = decodeIncremental(fs.readFileSync(file));
        if (result.complete) {
          console.log(`OK blocks=${result.blocks.length}`);
          return EXIT_OK;
        }
        console.log(`CORRUPT block=${result.corruptedAt ?? 'eof'} readable=${result.blocks.length}`);
        return EXIT_CORRUPT;
      }
      case 'commit': {
        const { flags, rest: pos } = parseFlags(rest);
        const [dir, base, graphFile] = pos;
        if (!dir || !base || !graphFile) return usage();
        const chunkSize = flags['chunk-size'] ? Number(flags['chunk-size']) : 8;
        const readSet = flags.read ? flags.read.split(',').filter(Boolean) : [];
        const writeSet = flags.write ? flags.write.split(',').filter(Boolean) : [];
        const store = Store.init(dir);
        const buffer = encodeGraph(loadGraphJson(graphFile), { chunkSize });
        const meta = store.commit({ base: base === '-' ? null : base, readSet, writeSet, buffer });
        console.log(meta.hash);
        return EXIT_OK;
      }
      case 'log': {
        const [dir] = rest;
        if (!dir) return usage();
        const store = Store.init(dir);
        for (const meta of [...store.versions.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1))) {
          console.log(JSON.stringify(meta));
        }
        return EXIT_OK;
      }
      default:
        return usage();
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      console.log(JSON.stringify(err.certificate));
      return EXIT_CONFLICT;
    }
    if (err instanceof RouteError) {
      console.error(err.code);
      return err.code === 'E_CORRUPT' ? EXIT_CORRUPT : EXIT_ROUTE_ERROR;
    }
    if (err?.code === 'E_UNKNOWN_BASE') {
      console.error(err.code);
      return EXIT_ROUTE_ERROR;
    }
    throw err;
  }
}

function usage() {
  console.error(USAGE);
  return EXIT_USAGE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
