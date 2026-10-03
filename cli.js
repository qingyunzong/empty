#!/usr/bin/env node
'use strict';
// 用法: node cli.js ops.jsonl report.json
// - 输入 JSONL：每行 {"ts","id","op","amount","scope"}；可含一行 {"op":"config","totalLimit","categoryLimits"}。
// - 账户配置优先级：JSONL 内 config 行 > 环境变量 BANK_CONFIG(指向 JSON 文件) > 默认 {totalLimit:1000}。
// - 业务失败(E_RANGE/E_LIMIT/E_DUP)：写入报告与审计，逐条打到 stderr，进程退出码 1。
// - 致命错误(文件不可读/JSON 解析失败/字段非法)：stderr + 退出码 1，不写报告。
// - 全部成功：写报告，退出码 0。

const fs = require('node:fs');
const { applyOps } = require('./bank');

function validateOp(obj, lineNo) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return `line ${lineNo}: not an object`;
  if (obj.op === 'config') {
    if (!Number.isFinite(obj.totalLimit) || obj.totalLimit <= 0) return `line ${lineNo}: config.totalLimit must be a positive number`;
    if (obj.categoryLimits !== undefined && (obj.categoryLimits === null || typeof obj.categoryLimits !== 'object' || Array.isArray(obj.categoryLimits))) {
      return `line ${lineNo}: config.categoryLimits must be an object`;
    }
    return null;
  }
  if (!Number.isFinite(obj.ts)) return `line ${lineNo}: ts must be a number`;
  if (typeof obj.id !== 'string' || obj.id === '') return `line ${lineNo}: id must be a non-empty string`;
  if (!['freeze', 'unfreeze', 'debit'].includes(obj.op)) return `line ${lineNo}: unknown op '${obj.op}'`;
  if (typeof obj.amount !== 'number' || !Number.isFinite(obj.amount)) return `line ${lineNo}: amount must be a number`;
  if (typeof obj.scope !== 'string' || obj.scope === '') return `line ${lineNo}: scope must be a non-empty string`;
  return null;
}

// run(argv, err) -> 退出码。err 为 stderr 输出回调，便于进程内测试。
function run(argv, err) {
  const [, , inputPath, outputPath] = argv;
  if (!inputPath || !outputPath) {
    err('usage: node cli.js <ops.jsonl> <report.json>');
    return 1;
  }

  let text;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    err(`E_IO cannot read ${inputPath}: ${e.message}`);
    return 1;
  }

  const ops = [];
  let config = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      err(`E_PARSE line ${i + 1}: invalid JSON (${e.message})`);
      return 1;
    }
    const errMsg = validateOp(obj, i + 1);
    if (errMsg) {
      err(`E_PARSE ${errMsg}`);
      return 1;
    }
    if (obj.op === 'config') {
      if (config) {
        err(`E_PARSE line ${i + 1}: duplicate config line`);
        return 1;
      }
      config = { totalLimit: obj.totalLimit, categoryLimits: obj.categoryLimits || {} };
    } else {
      ops.push(obj);
    }
  }

  if (!config && process.env.BANK_CONFIG) {
    try {
      config = JSON.parse(fs.readFileSync(process.env.BANK_CONFIG, 'utf8'));
    } catch (e) {
      err(`E_IO cannot read BANK_CONFIG ${process.env.BANK_CONFIG}: ${e.message}`);
      return 1;
    }
  }

  let report;
  try {
    report = applyOps(config, ops);
  } catch (e) {
    err(`E_INTERNAL ${e.message}`);
    return 1;
  }

  try {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  } catch (e) {
    err(`E_IO cannot write ${outputPath}: ${e.message}`);
    return 1;
  }

  const failed = report.steps.filter((s) => !s.ok);
  for (const s of failed) {
    err(`${s.code} id=${s.id} op=${s.op} reason=${s.reason}`);
  }
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv, (m) => process.stderr.write(m + '\n'));
}

module.exports = { run };
