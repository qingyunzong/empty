import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Replica } from './replica.js';

function fail(code) {
  return { code: 1, stdout: JSON.stringify({ error: code }) + '\n' };
}

function ok(value) {
  return { code: 0, stdout: JSON.stringify(value) + '\n' };
}

function parseArgs(argv) {
  const args = [...argv];
  let statePath = 'replica-state.json';
  const idx = args.indexOf('--state');
  if (idx !== -1) {
    statePath = args[idx + 1];
    args.splice(idx, 2);
  }
  const command = args.shift();
  let payload = {};
  let file = null;
  for (const arg of args) {
    if (arg.startsWith('{')) {
      try {
        payload = JSON.parse(arg);
      } catch {
        return { error: 'bad-json' };
      }
    } else if (file === null) {
      file = arg;
    }
  }
  return { command, statePath, payload, file };
}

function load(statePath) {
  if (!existsSync(statePath)) return { error: 'no-state' };
  try {
    return { replica: Replica.fromJSON(JSON.parse(readFileSync(statePath, 'utf8'))) };
  } catch {
    return { error: 'bad-state' };
  }
}

function save(statePath, replica) {
  writeFileSync(statePath, JSON.stringify(replica.toJSON(), null, 2) + '\n');
}

function readPeer(file) {
  if (!file || !existsSync(file)) return { error: 'no-file' };
  try {
    return { peer: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { error: 'bad-json' };
  }
}

function requireFields(payload, fields) {
  for (const field of fields) {
    if (payload[field] === undefined) return false;
  }
  return true;
}

function accountView(replica) {
  const accounts = {};
  for (const [name, acct] of Object.entries(replica.state.accounts)) {
    accounts[name] = {
      total: acct.total,
      frozen: acct.frozen,
      available: acct.total - acct.frozen,
    };
  }
  return {
    epoch: replica.state.epoch,
    accounts,
    members: replica.state.members,
    frontier: replica.state.frontier,
  };
}

export function runCli(argv) {
  const { command, statePath, payload, file } = parseArgs(argv);

  if (command === 'init') {
    if (!requireFields(payload, ['account', 'total', 'memberId'])) return fail('bad-request');
    if (existsSync(statePath)) return fail('already-initialized');
    const replica = Replica.init(payload);
    save(statePath, replica);
    return ok(accountView(replica));
  }

  const loaded = load(statePath);
  if (loaded.error) return fail(loaded.error);
  const replica = loaded.replica;

  switch (command) {
    case 'freeze': {
      if (!requireFields(payload, ['requestId', 'account', 'amount', 'memberId'])) return fail('bad-request');
      const res = replica.freeze(payload);
      if (res.error) return fail(res.error);
      save(statePath, replica);
      return ok(replica.state.events[res.id]);
    }
    case 'release': {
      if (!requireFields(payload, ['requestId', 'memberId'])) return fail('bad-request');
      const res = replica.release(payload);
      if (res.error) return fail(res.error);
      save(statePath, replica);
      return ok(replica.state.events[res.id]);
    }
    case 'add-member': {
      if (!requireFields(payload, ['member', 'by'])) return fail('bad-request');
      const res = replica.addMember(payload);
      if (res.error) return fail(res.error);
      save(statePath, replica);
      return ok(replica.state.events[res.id]);
    }
    case 'remove-member': {
      if (!requireFields(payload, ['member', 'by'])) return fail('bad-request');
      const res = replica.removeMember(payload);
      if (res.error) return fail(res.error);
      save(statePath, replica);
      return ok(replica.state.events[res.id]);
    }
    case 'diff': {
      const { peer, error } = readPeer(file);
      if (error) return fail(error);
      return ok(replica.diff(peer));
    }
    case 'merge': {
      const { peer, error } = readPeer(file);
      if (error) return fail(error);
      const result = replica.merge(peer);
      save(statePath, replica);
      return ok(result);
    }
    case 'account': {
      return ok(accountView(replica));
    }
    default:
      return fail('unknown-command');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, stdout } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exit(code);
}
