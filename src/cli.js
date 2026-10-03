#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addHold,
  createState,
  deserializeState,
  loadGraph,
  queryLot,
  releaseHold,
  serializeState,
  undo,
} from './freeze.js';

const DEFAULT_STATE_FILE = '.freeze-state.json';

function parseArgv(argv) {
  const args = [...argv];
  let stateFile = process.env.FREEZE_STATE_FILE ?? DEFAULT_STATE_FILE;
  const index = args.indexOf('--state');
  if (index !== -1) {
    stateFile = args[index + 1];
    args.splice(index, 2);
  }
  return { stateFile, args };
}

function loadStateFile(stateFile) {
  if (!existsSync(stateFile)) {
    throw new Error(`no state found at ${stateFile}; run 'load' first`);
  }
  return deserializeState(readFileSync(stateFile, 'utf8'));
}

function saveStateFile(stateFile, state) {
  writeFileSync(stateFile, serializeState(state));
}

function parseSeverity(raw) {
  if (raw === 'null') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`severity must be a number or null, got: ${raw}`);
  }
  return value;
}

function dispatch(argv, stdout) {
  const { stateFile, args } = parseArgv(argv);
  const [command, ...rest] = args;
  switch (command) {
    case 'load': {
      const [graphPath] = rest;
      if (!graphPath) throw new Error('usage: load <graph.json>');
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      const state = createState();
      loadGraph(state, graph);
      saveStateFile(stateFile, state);
      stdout(JSON.stringify({ loaded: true, lots: state.lots.size, edges: state.edges.length }));
      break;
    }
    case 'hold': {
      const [id, lot, type, severityRaw] = rest;
      if (!id || !lot || !type || severityRaw === undefined) {
        throw new Error('usage: hold <id> <lot> <supplier|customer> <severity|null>');
      }
      const state = loadStateFile(stateFile);
      const hold = addHold(state, { id, lot, type, severity: parseSeverity(severityRaw) });
      saveStateFile(stateFile, state);
      stdout(JSON.stringify({ held: hold }));
      break;
    }
    case 'release': {
      const [id] = rest;
      if (!id) throw new Error('usage: release <hold-id>');
      const state = loadStateFile(stateFile);
      const hold = releaseHold(state, id);
      saveStateFile(stateFile, state);
      stdout(JSON.stringify({ released: hold }));
      break;
    }
    case 'query': {
      const [lot] = rest;
      if (!lot) throw new Error('usage: query <lot>');
      const state = loadStateFile(stateFile);
      stdout(JSON.stringify(queryLot(state, lot)));
      break;
    }
    case 'undo': {
      const state = loadStateFile(stateFile);
      const entry = undo(state);
      saveStateFile(stateFile, state);
      stdout(JSON.stringify(entry ? { undone: entry.op, hold: entry.hold.id } : { undone: null }));
      break;
    }
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}; commands: load, hold, release, query, undo`);
  }
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  try {
    dispatch(argv, stdout);
    return 0;
  } catch (error) {
    stderr(`error: ${error.message}`);
    return 1;
  }
}

const invokedAsMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
