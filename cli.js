#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Searcher, buildCertificate, objectiveOf } = require('./src/scheduler');

// 返回 { code, stdout, stderr }, 便于进程内测试与 CLI 复用。
function run(file) {
  if (!file) return { code: 64, stdout: '', stderr: 'usage: node cli.js <plan.json>\n' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { code: 66, stdout: '', stderr: `ERR_IO: cannot read ${file}: ${err.message}\n` };
  }
  try {
    const searcher = new Searcher(raw);
    const res = searcher.solve();
    const payload = res
      ? { status: 'SAT', objective: objectiveOf(res.key), tiedPlans: res.plans.length, plans: res.plans }
      : buildCertificate(raw);
    return { code: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
  } catch (err) {
    if (err.code === 'ERR_DOMAIN') {
      return { code: 2, stdout: '', stderr: `ERR_DOMAIN: ${err.message}\n` };
    }
    throw err;
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv[2]);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

module.exports = { run };
