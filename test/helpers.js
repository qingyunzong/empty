'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeTmp(prefix = 'csvsync-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function csvContent(seed, rows = 5) {
  const lines = ['settlement_id,amount,fee'];
  for (let i = 0; i < rows; i++) lines.push(`${seed}-${i},${(i + 1) * 100}.00,${i}.50`);
  return lines.join('\n') + '\n';
}

function fileName(m, d, c) {
  return `${m}_${d}_${c}.csv`;
}

function writeCsv(dir, m, d, c, content) {
  fs.writeFileSync(path.join(dir, fileName(m, d, c)), content);
}

// 目录内容哈希: 排除 .sync 元数据, 对 (相对路径, 内容哈希) 排序后取 sha256
function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === '.sync') continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, rel + name + '/');
      else if (st.isFile()) {
        h.update(rel + name + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '\n');
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

function listCsv(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// 本沙箱中 node 孙进程的管道 stdout/stderr 会被吞掉, 改用文件重定向捕获
function runCli(args, opts = {}) {
  const tmp = makeTmp('csvsync-cli-');
  const outPath = path.join(tmp, 'out.txt');
  const errPath = path.join(tmp, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync('node', [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...(opts.env || {}) },
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

module.exports = { makeTmp, csvContent, fileName, writeCsv, dirHash, listCsv, sha256, runCli, CLI };
