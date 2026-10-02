import test from 'node:test';
import assert from 'node:assert/strict';
import { step, COMMANDS } from '../src/machine.js';
import { refStep } from '../src/reference.js';

// n<=9 全序列枚举：对 5 个命令的所有长度 1..9 序列，
// 逐步对照库状态机与独立参考状态机的接受/拒绝与结果状态。
test('n<=9 全序列枚举对照独立参考状态机', () => {
  let count = 0;
  function dfs(libStatus, refStatus, depth) {
    if (depth === 9) return;
    for (const cmd of COMMANDS) {
      const a = step(libStatus, cmd);
      const b = refStep(refStatus, cmd);
      assert.equal(a.ok, b.ok, `seq depth=${depth} cmd=${cmd} lib=${libStatus}`);
      if (a.ok) assert.equal(a.status, b.status);
      count += 1;
      dfs(a.ok ? a.status : libStatus, b.ok ? b.status : refStatus, depth + 1);
    }
  }
  dfs(null, null, 0);
  assert.equal(count, (5 ** 10 - 5) / 4); // sum_{k=1..9} 5^k = 2441405
});
