#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Ledger } from './src/ledger.js';
import { LedgerError, E_STOCK, E_SAVEPOINT, E_CRC, E_VALID } from './src/errors.js';

const EXIT_CODES = { [E_STOCK]: 2, [E_SAVEPOINT]: 3, [E_CRC]: 4, [E_VALID]: 5 };

const USAGE = `Usage: mledger [--dir <ledgerDir>] <command> [options]

Commands:
  receive  --batch B --qty N [--parent P] --key K   入库
  reserve  --batch B --qty N --key K                预留
  issue    --batch B --qty N --key K                发料 (父批次按比例消耗子批次)
  return   --batch B --qty N --key K                退料
  savepoint --name S                                记录保存点
  rollback --name S                                 追加反向补偿并生成回滚证书
  snapshot                                          写快照并更新清单
  recover                                           截断损坏尾部块并修复清单
  balance                                           输出库存状态
  history                                           输出全部记录

Exit codes: 0 ok, 2 E_STOCK, 3 E_SAVEPOINT, 4 E_CRC, 5 E_VALID, 1 other`;

function parseArgs(argv) {
  const opts = { dir: process.env.MLEDGER_DIR ?? './ledger' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      opts[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

export function run(argv) {
  let stdout = '';
  let stderr = '';
  const print = (value) => {
    stdout += `${JSON.stringify(value, null, 2)}\n`;
  };
  const { opts, positional } = parseArgs(argv);
  const command = positional[0];
  try {
    if (!command || command === 'help') {
      stdout += `${USAGE}\n`;
      return { code: command ? 0 : 5, stdout, stderr };
    }
    switch (command) {
      case 'receive':
      case 'reserve':
      case 'issue':
      case 'return': {
        const ledger = Ledger.open(opts.dir);
        const params = { batch: opts.batch, qty: Number(opts.qty) };
        if (opts.parent !== undefined) params.parent = opts.parent;
        const result = ledger.execute(command, params, opts.key ?? '');
        print(result);
        return { code: result.ok ? 0 : (EXIT_CODES[result.code] ?? 1), stdout, stderr };
      }
      case 'savepoint': {
        print(Ledger.open(opts.dir).savepoint(opts.name ?? ''));
        return { code: 0, stdout, stderr };
      }
      case 'rollback': {
        print(Ledger.open(opts.dir).rollback(opts.name ?? ''));
        return { code: 0, stdout, stderr };
      }
      case 'snapshot': {
        print(Ledger.open(opts.dir).snapshot());
        return { code: 0, stdout, stderr };
      }
      case 'recover': {
        print(Ledger.recover(opts.dir));
        return { code: 0, stdout, stderr };
      }
      case 'balance': {
        print(Ledger.open(opts.dir).status());
        return { code: 0, stdout, stderr };
      }
      case 'history': {
        print(Ledger.open(opts.dir).history());
        return { code: 0, stdout, stderr };
      }
      default:
        throw new LedgerError(E_VALID, `unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      stderr += `${JSON.stringify({ ok: false, code: err.code, message: err.message })}\n`;
      return { code: EXIT_CODES[err.code] ?? 1, stdout, stderr };
    }
    stderr += `${err.stack ?? err}\n`;
    return { code: 1, stdout, stderr };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
