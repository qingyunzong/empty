'use strict';

const fs = require('fs');
const { SettlementEngine } = require('./lib/engine');
const { Ledger } = require('./lib/ledger');
const { validateInput } = require('./lib/validate');

// 返回进程退出码；errFn 便于测试捕获错误输出
function main(argv, errFn = console.error) {
  const [, , cmd, inputPath, outputPath] = argv;
  if (cmd !== 'deliver' || !inputPath || !outputPath) {
    errFn('用法: node . deliver input.json output.json');
    return 1;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    errFn(`输入 JSON 无效: ${err.message}`);
    return 1;
  }
  try {
    validateInput(input);
  } catch (err) {
    errFn(`输入无效: ${err.message}`);
    return 1;
  }
  // 指定 walPath 时先按 WAL 恢复（完成解冻或回滚配对），再继续交收
  const ledger = input.walPath ? Ledger.recover(input.accounts, input.walPath) : null;
  const engine = new SettlementEngine({
    accounts: input.accounts,
    instructions: input.instructions,
    permissions: input.permissions ?? {},
    walPath: input.walPath ?? null,
    ledger,
  });
  let result = engine.settle();
  if (Array.isArray(input.cancellations) && input.cancellations.length > 0) {
    engine.cancel(input.cancellations); // 先解冻再拆配对
    result = engine.rematch(); // 增量重配
  }
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
