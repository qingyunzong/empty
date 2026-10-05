# 实际测试结果

- 日期：2026-10-06（Asia/Shanghai）
- 环境：Node.js v22.22.1，npm 9.2.0，TypeScript 7.0.2（全局 `tsc`）
- 命令：`npm test`

## `npm test` 输出（原文记录）

```
> relation-store@1.0.0 test
> tsc -p tsconfig.build.json && node --test dist/test/store.test.js dist/test/random.test.js

TAP version 13
# Subtest: dist/test/random.test.js
ok 1 - dist/test/random.test.js
  ---
  duration_ms: 897.457751
  type: 'test'
  ...
# Subtest: dist/test/store.test.js
ok 2 - dist/test/store.test.js
  ---
  duration_ms: 847.95153
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 969.138326
```

## 明细（`node --test --test-reporter=spec`）

```
✔ dist/test/random.test.js (847.755659ms)
✔ dist/test/store.test.js (798.025128ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 921.007245
```

## 覆盖的测试用例

- `test/store.test.ts`（8 个用例，全部通过）：
  1. diff 输出新增 / 删除 / 标签修改
  2. 同端点多 ID 不合并
  3. 自环与循环允许
  4. 批次原子性（单个非法操作拒绝整批，版本与状态不变）
  5. 空批次仍生成新版本
  6. 同 id 端点变更按 remove+add 处理而非标签修改
  7. 逆差应用于后像还原前像（含正向应用验证）
  8. 未知版本抛 `StoreError`
- `test/random.test.ts`（2 个用例，全部通过）：
  1. 30 组随机种子的随机版本历史：随机版本对的 diff 与集合差参考模型
     逐一比对一致；正向应用达到后像，逆差应用还原前像
  2. 200 次随机非法批次：全部抛错且库状态保持不变

`npm run typecheck`（`tsc --noEmit`）亦通过，无类型错误。
