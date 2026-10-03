#!/usr/bin/env node
'use strict';

const { Platform, PlatformError } = require('./platform');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') {
      opts.state = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function readJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformError('INVALID_JSON', `invalid JSON for ${what}`);
  }
}

function execute(argv) {
  const { positional, opts } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const stateDir = opts.state || null;

  let platform = stateDir ? Platform.load(stateDir) : null;
  const needPlatform = () => {
    if (!platform) {
      throw new PlatformError('NO_STATE', 'no state found; run `init` first or pass --state');
    }
    return platform;
  };

  let out;
  let mutate = false;
  switch (cmd) {
    case 'init': {
      const config = rest[0] ? readJson(rest[0], 'config') : {};
      platform = new Platform({ ...config, stateDir });
      out = { ok: true, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'submit': {
      const spec = readJson(rest[0], 'node spec');
      const node = needPlatform().submit(spec);
      out = { ok: true, id: node.id, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'correct': {
      const patch = readJson(rest[1] || '{}', 'correction patch');
      const invalidated = needPlatform().correct(rest[0], patch);
      out = { ok: true, invalidated, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'invalidate': {
      const invalidated = needPlatform().invalidate(rest[0]);
      out = { ok: true, invalidated, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'preempt': {
      const preempted = needPlatform().preempt();
      out = { ok: true, preempted, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'schedule': {
      const result = needPlatform().schedule();
      out = { ...result, root: platform.stateRoot() };
      mutate = true;
      break;
    }
    case 'commit': {
      out = needPlatform().commit();
      mutate = true;
      break;
    }
    case 'undo': {
      out = needPlatform().undo();
      mutate = true;
      break;
    }
    case 'status': {
      const p = needPlatform();
      out = {
        generation: p.generation,
        root: p.stateRoot(),
        ownerBytes: Object.fromEntries(p.ownerBytes),
        nodes: Object.fromEntries([...p.nodes.values()].map((n) => [n.id, n.status])),
      };
      break;
    }
    default:
      throw new PlatformError(
        'USAGE',
        'usage: cli.js <init|submit|correct|invalidate|preempt|schedule|commit|undo|status> [args] [--state dir]',
      );
  }

  if (mutate && stateDir) platform.saveWork();
  return out;
}

function runCli(argv) {
  try {
    const out = execute(argv);
    return { status: 0, stdout: JSON.stringify(out) + '\n', stderr: '' };
  } catch (err) {
    if (err instanceof PlatformError) {
      return { status: 7, stdout: '', stderr: `${err.code}: ${err.message}\n` };
    }
    throw err;
  }
}

if (require.main === module) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
}

module.exports = { runCli };
