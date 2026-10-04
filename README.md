# strategy-library

仅使用 TypeScript + Node.js 内置库（`node:crypto`、`node:test`、`node:assert`）实现的追加式版本化策略库。

## 特性

- **批增删差分**：`publish(ops)` 接受批量 put/delete，生成每条规则带前摘要（before）与后摘要（after）的差分；摘要含完整决议（decision）、来源（source）及内容哈希（SHA-256）。
- **逆发布先核后像**：`inversePublish(target)` 先把目标到当前的差分链复合、求逆，在临时副本上重放并校验结果指纹与目标历史版本一致（核）；校验通过才追加恢复出的新映像（像）。任何不一致抛 `DiffVerificationError`，历史不变。
- **热更与读者快照隔离**：`getSnapshot()` 返回私有副本 + 深度冻结的只读视图；发布新策略不影响已持有快照的读者。
- **历史不可变**：版本日志只追加，版本对象与差分深度冻结，任何历史版本永不修改。
- **差分复合**：`composeDiffs` 合并相邻差分（净无变化的条目消去），`invertDiff` 生成逆差分，`applyDiffChecked` 先核后放。

## 运行

```sh
npm test   # tsc 编译 + node --test 运行
```

## 实测结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - 批量增删发布生成带前后摘要的差分
ok 2 - 历史版本不可变：发布后旧版本指纹与内容不变且被冻结
ok 3 - 策略热更与读者快照隔离
ok 4 - 逆发布先核后像：决议与来源完全恢复，历史只增不改
ok 5 - 逆发布目标非法时抛错且历史不变
ok 6 - 差分校验：前置摘要或指纹被篡改时拒绝应用（先核）
ok 7 - 差分复合：compose 等价于顺序应用
ok 8 - 随机化：差分复合与逆发布完全恢复决议及来源
ok 9 - 逆差分结构：invert 后再应用回到原点
# tests 1  # pass 1  # fail 0   （npm test 汇总：pass 1 / fail 0，退出码 0）
```

随机化测试（固定种子 `0xc0ffee` 的 mulberry32，40 轮）：每轮随机 1–12 次发布、每次 1–8 条增删改；随后随机取相邻区间做差分复合并断言「复合应用 == 顺序应用 == 模型状态」，再随机逆发布到历史版本，断言决议与来源完全恢复、指纹一致、历史版本逐一未被改变。

## 文件

- `src/strategy-library.ts` — 核心实现（Rule/RuleSummary/Diff/Version、StrategyLibrary、Snapshot、compose/invert/applyDiffChecked）
- `test/strategy-library.test.ts` — 9 项测试（含随机化属性测试）
- `types/node-shims.d.ts` — Node 内置模块的最小类型声明（离线环境无需 @types/node）
