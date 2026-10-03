'use strict';

const { runInput } = require('./engine');

// 解析输入文本并返回输出 JSON 文本；输入非法时抛出带 exitCode 的错误。
function runCliText(text) {
  const input = JSON.parse(text);
  return JSON.stringify(runInput(input), null, 2) + '\n';
}

module.exports = { runCliText };
