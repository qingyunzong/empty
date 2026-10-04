# 两阶段事务（2PC）模拟器

仅使用 Node.js 内置库（`node:fs` / `node:path` / `node:test` 等）与 TypeScript 实现，
无任何 npm 依赖。模拟两阶段提交协议，验证崩溃恢复下的原子性。

## 核心保证

- **持久记录**：协调者与每个参与者各自维护一份只追加的 WAL（JSONL，每次写入后 `fsync`）。
  准备（BEGIN/VOTE）与决议（DECISION/END）全部先落盘再推进。
- **重启只沿记录续行**：协调者不持有任何权威内存状态；每次运行先重放 WAL 恢复状态机，
  崩溃后重建的进程严格且仅从磁盘记录继续。
- **未决不能冒充回滚**：恢复时若没有 DECISION 记录，协调者不会凭空捏造 ABORT 来"解套"，
  而是向参与者重新收集投票（参与者按已持久化的投票幂等应答），再据实持久化决议；
  已投 YES 而未收到决议的参与者处于 IN_DOUBT 阻塞态，如实上报，绝不伪报 ABORTED。
- **重复投票幂等**：参与者重复收到 prepare 时返回已持久化的投票，日志只记一条；
  决议重复送达同样幂等，冲突决议会被拒绝。
- **任意落盘点中断**：故障注入器在每个持久化点（`coordinator:begin`、`coordinator:vote:<p>`、
  `coordinator:decision`、`coordinator:notify:<p>`、`coordinator:end`、`participant:<id>:vote`、
  `participant:<id>:decision` 等）可触发模拟崩溃，测试对每个点逐一验证恢复。
- **独立状态检查器**：`src/checker.ts` 不与协调者/参与者共享任何代码路径，
  直接读取磁盘日志核对：参与者间决议一致（AGREEMENT）、参与者决议与协调者记录一致、
  无协调者 COMMIT 记录则不得有提交、COMMIT 要求全员 YES、END 后所有参与者须持有决议。

## 结构

- `src/wal.ts` — 只追加、写后 fsync 的 JSONL 日志
- `src/coordinator.ts` — 事件溯源协调者（重放日志驱动状态机）
- `src/participant.ts` — 参与者（幂等投票/决议，IN_DOUBT 诚实上报）
- `src/fault.ts` — 确定性故障注入器
- `src/simulator.ts` — 场景运行器：崩溃后以全新对象从磁盘重启
- `src/checker.ts` — 独立一致性检查器
- `test/twopc.test.ts` — 13 个测试（含全落盘点崩溃扫描、幂等、反例）
- `scripts/run-tests.mjs` — 测试执行与结果记录

## 运行

```sh
npm test
```

执行 `tsc` 编译后运行全部测试，实际结果（时间、Node 版本、TAP 原文）记录于
`TEST-RESULTS.md`；任一测试失败则 `npm test` 以非零码退出。

> 注：本沙箱环境中 `node --test` 的子进程管道无法回传输出，故运行脚本改为
> 进程内导入测试文件并捕获 TAP 输出，语义等价。
