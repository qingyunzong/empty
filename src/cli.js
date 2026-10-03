#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Replica, SmError, hashEvent } from './statemachine.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function loadReplica(dbPath, replicaFlag) {
  if (dbPath && existsSync(dbPath)) {
    return Replica.fromJSON(readFileSync(dbPath, 'utf8'));
  }
  return new Replica(replicaFlag || process.env.ORDER_REPLICA || 'replica-1');
}

function viewJson(view) {
  return {
    orderId: view.orderId,
    state: view.state,
    events: view.events.map((e) => ({ ...e, hash: hashEvent(e) })),
    rejected: view.rejected,
    resolution: view.resolution
      ? { eventId: view.resolution.eventId, to: view.resolution.to, reason: view.resolution.reason || '' }
      : null,
  };
}

// Runs one CLI invocation. Returns the exit code; emits one JSON line via io.stdout.
export function run(argv, io = {}) {
  const emit = io.stdout || ((line) => process.stdout.write(`${line}\n`));
  const out = (value) => emit(JSON.stringify(value));
  const fail = (code) => {
    out({ error: code });
    return 1;
  };

  try {
    const { flags, positional } = parseArgs(argv);
    const [command, ...rest] = positional;
    const dbPath = flags.db || process.env.ORDER_DB || null;

    if (!command) {
      return fail('usage: cli [--db file] [--replica id] <create|cancel|match|resolve|merge|state|cert> ...');
    }

    const replica = loadReplica(dbPath, flags.replica);
    const mutating = ['create', 'cancel', 'match', 'resolve', 'merge'].includes(command);
    let result;

    switch (command) {
      case 'create': {
        const [orderId] = rest;
        if (!orderId) return fail('missing-order-id');
        result = viewJson(replica.createOrder(orderId));
        break;
      }
      case 'cancel':
      case 'match': {
        const [orderId] = rest;
        if (!orderId) return fail('missing-order-id');
        const { event, view } = replica[command](orderId, flags['event-id']);
        result = { ...viewJson(view), event };
        break;
      }
      case 'resolve': {
        const [orderId] = rest;
        if (!orderId) return fail('missing-order-id');
        if (!flags.to) return fail('missing-to');
        const { event, view } = replica.resolve(orderId, flags.to, flags.reason || '', flags['event-id']);
        result = { ...viewJson(view), event };
        break;
      }
      case 'merge': {
        const [file] = rest;
        if (!file) return fail('missing-file');
        if (!existsSync(file)) return fail('file-not-found');
        replica.merge(Replica.fromJSON(readFileSync(file, 'utf8')));
        result = { merged: file, orders: replica.listOrders().map(viewJson) };
        break;
      }
      case 'state': {
        const [orderId] = rest;
        if (!orderId) return fail('missing-order-id');
        result = viewJson(replica.getOrder(orderId));
        break;
      }
      case 'cert': {
        const [orderId] = rest;
        if (!orderId) return fail('missing-order-id');
        result = replica.certificate(orderId);
        break;
      }
      default:
        return fail('unknown-command');
    }

    if (mutating && dbPath) writeFileSync(dbPath, `${JSON.stringify(replica.toJSON(), null, 2)}\n`);
    out(result);
    return 0;
  } catch (err) {
    if (err instanceof SmError) return fail(err.code);
    return fail('internal-error');
  }
}

const invokedAsMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  process.exit(run(process.argv.slice(2)));
}
