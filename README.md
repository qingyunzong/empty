# stage-orchestrator

测试编排库：以阶段 DAG 组织测试任务，按**输入摘要**缓存阶段结果，成功阶段可复用，
失败仅重跑其后继，文件变化精确失效相关缓存，结果发布原子化。纯 TypeScript +
Node.js 内置库，零第三方依赖。

## 设计

- `src/dag.ts` — 阶段 DAG：拓扑排序（Kahn）、环/重复/未知依赖校验、后继集合计算。
- `src/digest.ts` — 输入摘要：`sha256(stageId + 输入文件内容 + 直接依赖输出)`，
  稳定序列化（键排序）保证确定性。任何上游变化都会改变摘要，使过期成功记录在
  寻址上不可达。
- `src/cache.ts` — 内容寻址缓存。发布原子化：写临时文件 → `fsync` → `rename`
  → 目录 `fsync`；记录带 `valueHash` 完整性标签，篡改/过期记录视为未命中；
  `sweep()` 清理崩溃残留的临时文件。
- `src/executor.ts` — 可控执行器。按拓扑序执行：缓存命中则复用；阶段失败只
  标记自身与其后继（其余分支照常复用/执行）；`crashAt` 钩子可在
  `before-run` / `tmp-written` / `after-publish` 三个精确点位注入断电
  （默认 `process.exit(1)`，测试注入不可捕获的异常模拟硬断电，崩溃不会被
  吞成阶段失败）。

## 断电语义

- `after-publish` 崩溃：记录已原子提交，重启后该阶段复用，后继继续执行。
- `tmp-written` 崩溃（rename 前）：缓存目录只留孤儿临时文件，无部分记录可见；
  重启后该阶段重新执行，临时文件被清扫。
- 断电期间输入文件被修改：相关子树摘要变化，过期成功记录不会被复用。

注：沙箱禁止派生真实子进程，断电测试采用进程内模拟（注入异常硬中断 +
全新 `Executor` 实例模拟重启）；`crash` 默认实现仍是真实 `process.exit`，
可在非沙箱环境用于真实进程级断电验证。

## 测试

`npm test`（编译 + `node --test`）。实际运行结果（Node v22.22.1，2026-10-05）：

```
ok 1 - topoSort orders dependencies before dependents
ok 2 - topoSort rejects cycles
ok 3 - validateStages rejects duplicates and unknown deps
ok 4 - descendantsOf returns transitive dependents only
ok 1 - successful stages are reused on a second run
ok 2 - a failure reruns only the failed stage and its successors
ok 3 - editing an input file invalidates that stage and its successors only
ok 4 - tampered cache records fail integrity checks and are not reused
ok 5 - leftover temp files are swept and never treated as cache hits
ok 1 - power loss after a committed publish reuses it and resumes successors
ok 2 - power loss mid-publish leaves no visible record; stage re-executes
ok 3 - stale successes are not reused when inputs changed while powered off

# tests 3   # 3 个测试文件，共 12 个用例
# pass 3
# fail 0
# duration_ms ~280
```

说明：环境无网络，无法安装 `@types/node`，`src/node-shims.d.ts` 提供本项目
用到的 Node 内置 API 的最小类型声明。
