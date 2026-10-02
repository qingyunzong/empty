#!/usr/bin/env node
'use strict';

const { Store } = require('./store');
const { BusinessError, CorruptionError } = require('./errors');

// 退出码：0 成功 / 1 业务错误 / 2 数据或索引损坏

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        if (args[key] === undefined) args[key] = true;
      } else {
        if (args[key] === undefined) args[key] = next;
        else if (Array.isArray(args[key])) args[key].push(next);
        else args[key] = [args[key], next];
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function required(args, key) {
  if (args[key] === undefined || args[key] === true) throw new BusinessError(`missing --${key}`);
  return args[key];
}

function num(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BusinessError(`invalid ${what}: ${v}`);
  return n;
}

function openStore(args) {
  return Store.open(required(args, 'data'));
}

function cmdInit(args) {
  const list = args.account === undefined ? [] : Array.isArray(args.account) ? args.account : [args.account];
  const accounts = {};
  for (const spec of list) {
    const [name, budget, credit, balance] = String(spec).split(':');
    if (!name) throw new BusinessError(`invalid account spec: ${spec}`);
    accounts[name] = {
      budget: num(budget, 'budget'),
      credit: num(credit, 'credit'),
      balance: num(balance, 'balance'),
    };
  }
  const store = Store.init(required(args, 'data'), accounts);
  return { ok: true, initialized: store.dir };
}

function cmdTx(kind, args) {
  const store = openStore(args);
  const tx = {
    id: required(args, 'tx'),
    kind,
    account: required(args, 'account'),
    amount: num(required(args, 'amount'), 'amount'),
  };
  if (args.parent !== undefined) tx.parent = args.parent;
  const opts = args.crash !== undefined ? { crash: String(args.crash) } : {};
  const r = store.commitLayer(kind, [tx], opts);
  return { ok: true, layer: r.layer, hash: r.hash };
}

function cmdRevert(args) {
  const store = openStore(args);
  const tx = { id: required(args, 'tx'), kind: 'revert', target: required(args, 'target') };
  const opts = args.crash !== undefined ? { crash: String(args.crash) } : {};
  const r = store.commitLayer('revert', [tx], opts);
  return { ok: true, layer: r.layer, hash: r.hash };
}

function cmdCheckpoint(args) {
  const r = openStore(args).checkpoint();
  return { ok: true, layer: r.layer, hash: r.hash };
}

function cmdRestore(args) {
  const opts = {};
  if (args.checkpoint !== undefined) opts.checkpointLayer = num(args.checkpoint, 'checkpoint layer');
  if (args.target !== undefined) opts.targetLayer = num(args.target, 'target layer');
  const r = openStore(args).restore(opts);
  return { ok: true, layer: r.layer, state: r.state, orphans: r.orphans };
}

function cmdVerify(args) {
  const r = openStore(args).verify();
  return { ok: true, ...r };
}

const USAGE = `usage:
  settle init        --data DIR [--account name:budget:credit:balance]...
  settle reserve     --data DIR --tx ID --account NAME --amount N [--parent TX]
  settle freeze      --data DIR --tx ID --account NAME --amount N [--parent TX]
  settle pay         --data DIR --tx ID --account NAME --amount N [--parent TX]
  settle revert      --data DIR --tx ID --target TX
  settle checkpoint  --data DIR
  settle restore     --data DIR [--checkpoint LAYER] [--target LAYER]
  settle verify      --data DIR
exit codes: 0 success, 1 business error, 2 corruption`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'init': return cmdInit(args);
    case 'reserve': return cmdTx('reserve', args);
    case 'freeze': return cmdTx('freeze', args);
    case 'pay': return cmdTx('pay', args);
    case 'revert': return cmdRevert(args);
    case 'checkpoint': return cmdCheckpoint(args);
    case 'restore': return cmdRestore(args);
    case 'verify': return cmdVerify(args);
    case undefined:
    case 'help':
    case '--help':
      return { ok: true, usage: USAGE };
    default:
      throw new BusinessError(`unknown command: ${cmd}\n${USAGE}`);
  }
}

// 可进程内调用的执行入口：返回 { code, stdout, stderr }，不调用 process.exit。
function run(argv) {
  try {
    const out = main(argv);
    return { code: 0, stdout: out === undefined ? '' : `${JSON.stringify(out, null, 2)}\n`, stderr: '' };
  } catch (err) {
    const code = err instanceof CorruptionError ? 2 : err instanceof BusinessError ? 1 : (err && err.exitCode) || 1;
    return { code, stdout: '', stderr: `${JSON.stringify({ ok: false, type: err.name, error: err.message })}\n` };
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

module.exports = { main, run, parseArgs };
