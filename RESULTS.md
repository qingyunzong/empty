# 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），Linux x86_64。
日期：2026-10-05。

## `npm test`（tsc 构建 + node --test）

```
> dag-test-orchestrator@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

# Subtest: dist/test/cache.test.js
ok 1 - dist/test/cache.test.js
# Subtest: dist/test/crash.test.js
ok 2 - dist/test/crash.test.js
# Subtest: dist/test/orchestrator.test.js
ok 3 - dist/test/orchestrator.test.js
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# duration_ms ~480
```

## 逐条用例（node --test-reporter=spec，18 条全部通过）

```
✔ 缓存记录: 写入后可读回，校验和自验证
✔ 缓存记录: 被篡改/截断的记录视为未命中并清除
✔ 原子发布: 提交后无临时文件残留；崩溃遗留的 tmp 被清理
✔ 原子发布: tmp 写入后、rename 前断电 -> 目标文件不出现
✔ 原子发布: rename 之后断电 -> 完整记录可读（rename 是原子提交点）
✔ atomicWriteFileSync: 通用原子发布同样抵御中途断电
✔ 断电点 P1: 提交中途（tmp 已写、rename 未做）-> 重启后该阶段重跑，不留残骸
✔ 断电点 P2: a 已提交、b 未执行 -> 重启后仅 a 复用，b/c 重跑
✔ 断电点 P3: 断电后输入文件变化 -> 过期成功绝不复用
✔ 断电点 P4: 手工伪造的过期记录（校验和合法但摘要过期）不被复用
✔ 结果发布: 运行报告原子落盘且内容完整
✔ DAG: 依赖先于后继执行，后继收到依赖输出
✔ DAG: 环与未知依赖被拒绝
✔ 缓存: 第二次运行全部复用成功结果，run 不再调用
✔ 失效: 输入文件变化仅使相关分支失效
✔ 失败: 仅重跑失败阶段及其后继，无关分支保持缓存
✔ 传播: 依赖输出变化使后继失效；输出不变则后继复用
✔ 可控执行器: ManualExecutor 按队列顺序确定性调度

tests 18 / pass 18 / fail 0
```
