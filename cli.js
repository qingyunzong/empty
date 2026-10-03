#!/usr/bin/env node
'use strict';

// 用法: node cli.js [input.json]   （缺省从 stdin 读取）
// 输入: { timezones, calendar, calendarWindow, stream } 的 JSON 事务流
// 输出: { setupErrors, results, finalVersion, resources } 的 JSON

const fs = require('fs');
const { runCliText } = require('./src/cli');

function main() {
  const arg = process.argv[2];
  const text = arg ? fs.readFileSync(arg, 'utf8') : fs.readFileSync(0, 'utf8');
  try {
    process.stdout.write(runCliText(text));
  } catch (err) {
    process.stderr.write(`invalid input: ${err.message}\n`);
    process.exit(2);
  }
}

main();
