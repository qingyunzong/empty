#!/usr/bin/env node
'use strict';

// 用法:
//   node cli.js init
//   node cli.js append --author A --payload P [--parents id1,id2]
//   node cli.js merge h1 h2
//   node cli.js heads
//   node cli.js is-ancestor a b
//   node cli.js checkout head
//   node cli.js remove head [--author A]
//   node cli.js events
// 全局选项: --dir <历史目录>（默认环境变量 HISTORY_DIR，否则 ./history）
// 结果输出 JSON 到 stdout；错误输出 JSON 到 stderr 并以非零码退出。

const { History, HistoryError } = require('./lib/history.js');

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      opts[key] = argv[i + 1];
      i++;
    } else {
      args.push(argv[i]);
    }
  }
  return { args, opts };
}

// 返回退出码；io 提供 stdout/stderr 写入函数（便于进程内测试）
function run(argv, io) {
  const out = (obj) => io.stdout(JSON.stringify(obj));
  const { args, opts } = parseArgs(argv);
  const cmd = args[0];
  const dir = opts.dir || process.env.HISTORY_DIR || './history';

  if (!cmd) {
    io.stderr(JSON.stringify({ error: 'ERR_USAGE', message: '缺少命令' }));
    return 2;
  }

  try {
    if (cmd === 'init') {
      History.init(dir);
      out({ ok: true, dir });
      return 0;
    }

    const h = History.open(dir);

    switch (cmd) {
      case 'append': {
        const parents = opts.parents ? opts.parents.split(',').filter(Boolean) : undefined;
        const id = h.append({ author: opts.author, payload: opts.payload ?? '', parents });
        out({ id, heads: h.heads() });
        return 0;
      }
      case 'merge': {
        const id = h.merge(args[1], args[2]);
        out({ head: id, heads: h.heads() });
        return 0;
      }
      case 'heads': {
        out({ heads: h.heads() });
        return 0;
      }
      case 'is-ancestor': {
        out({ isAncestor: h.isAncestor(args[1], args[2]) });
        return 0;
      }
      case 'checkout': {
        out(h.checkout(args[1]));
        return 0;
      }
      case 'remove': {
        const tomb = h.remove(args[1], opts.author || 'system:undo');
        out({ tombstone: tomb, heads: h.heads() });
        return 0;
      }
      case 'events': {
        out({ events: h.listEvents() });
        return 0;
      }
      default:
        io.stderr(JSON.stringify({ error: 'ERR_USAGE', message: `未知命令: ${cmd}` }));
        return 2;
    }
  } catch (err) {
    const code = err instanceof HistoryError ? err.code : 'ERR_INTERNAL';
    io.stderr(JSON.stringify({ error: code, message: err.message }));
    return 1;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s + '\n'),
    stderr: (s) => process.stderr.write(s + '\n'),
  });
  process.exit(code);
}

module.exports = { run };
