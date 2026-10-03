#!/usr/bin/env node
'use strict';
// 用法:
//   node cli.js build  <src> <data> <idx> [blockSize=65536] [interval=16]
//   node cli.js read   <data> <idx> <offset> <len>     # 载荷字节写 stdout
//   node cli.js verify <data> <idx>
//   node cli.js repair <data> <idx>
// 错误: stderr 输出 JSON {"error":"ERR_INDEX|ERR_CRC|ERR_RANGE|ERR_BLOOM",...}, 退出码 1。

const { build, open, verifyIndex, repair, RsError } = require('./index');

// io: { stdout(Buffer|string), stderr(string) }, 便于进程内测试
function run(argv, io = { stdout: (b) => process.stdout.write(b), stderr: (s) => process.stderr.write(s) }) {
  try {
    const [, , cmd, ...args] = argv;
    switch (cmd) {
      case 'build': {
        const [src, data, idx, blockSize, interval] = args;
        if (!src || !data || !idx) throw new RsError('ERR_RANGE', 'usage: build <src> <data> <idx> [blockSize] [interval]');
        const stats = build(src, data, idx, {
          blockSize: blockSize === undefined ? undefined : Number(blockSize),
          interval: interval === undefined ? undefined : Number(interval),
        });
        io.stdout(JSON.stringify({ ok: true, ...stats }) + '\n');
        return 0;
      }
      case 'read': {
        const [data, idx, offset, len] = args;
        if (!data || !idx || offset === undefined || len === undefined) {
          throw new RsError('ERR_RANGE', 'usage: read <data> <idx> <offset> <len>');
        }
        const h = open(data, idx);
        try {
          io.stdout(h.read(Number(offset), Number(len)));
        } finally {
          h.close();
        }
        return 0;
      }
      case 'verify': {
        const [data, idx] = args;
        verifyIndex(data, idx);
        io.stdout(JSON.stringify({ ok: true }) + '\n');
        return 0;
      }
      case 'repair': {
        const [data, idx] = args;
        const stats = repair(data, idx);
        io.stdout(JSON.stringify({ ok: true, ...stats }) + '\n');
        return 0;
      }
      default:
        throw new RsError('ERR_RANGE', `unknown command: ${cmd ?? '(none)'}`);
    }
  } catch (err) {
    const code = err instanceof RsError ? err.code : 'ERR_INDEX';
    io.stderr(JSON.stringify({ error: code, message: err.message }) + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv));
}

module.exports = { run };
