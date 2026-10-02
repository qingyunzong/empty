#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { buildReport, verifyReport, ReportError } = require('./lib');

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new ReportError('E_IO', 'cannot read ' + path + ': ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ReportError('E_PARSE', 'invalid JSON in ' + path + ': ' + err.message);
  }
}

// 返回退出码;io 可注入以便测试。错误一律写 stderr,退出码 1。
function run(argv, io) {
  try {
    const cmd = argv[0];
    const args = argv.slice(1);
    if (cmd === 'build' && args.length === 2) {
      const spec = readJson(args[0]);
      const report = buildReport(spec, spec.request);
      fs.writeFileSync(args[1], JSON.stringify(report, null, 2) + '\n');
      io.stdout(
        'built ' + args[1] + ' unit=' + report.unit + ' role=' + report.role +
        ' sources=' + report.proof.sourceClosure.length +
        ' hash=' + report.proof.canonicalHash + '\n'
      );
      return 0;
    }
    if (cmd === 'verify' && args.length === 1) {
      const report = readJson(args[0]);
      const res = verifyReport(report);
      io.stdout(
        'OK unit=' + res.unit + ' role=' + res.role +
        ' sources=' + res.sources + ' hash=' + res.hash + '\n'
      );
      return 0;
    }
    io.stderr('usage: node cli.js build <spec.json> <report.json>\n');
    io.stderr('       node cli.js verify <report.json>\n');
    return 1;
  } catch (err) {
    const code = err instanceof ReportError ? err.code : 'E_INTERNAL';
    io.stderr(code + ': ' + err.message + '\n');
    if (err.details !== undefined) io.stderr(JSON.stringify(err.details, null, 2) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

module.exports = { run };
