# pay-ledger

支付中台账本库 + CLI：授权冻结 / 扣款 / 撤销 / 红冲，分层撤销树，精确有理数金额，
append-only 崩溃安全持久化。Node.js 22，仅标准库，测试用 `node:test`。

## 布局

- `src/frac.js` — BigInt 有理数 `Frac`（`num/den`，自动约分）与 `roundHalfEven`（银行家舍入，默认分位 scale=100）
- `src/ledger.js` — 核心 `Ledger`：事件树 + 分层撤销树 + 分支/合并
- `src/store.js` — append-only 日志 `Store`、崩溃恢复、`loadLedger` 重放
- `src/cli.js` — `runCli(argv)`（进程内可测），`bin/pay.js` 为薄封装
- `src/errors.js` — `LedgerError`，错误码 `E_PARSE / E_REF / E_STATE / E_IO`

## 事件流

| 事件 | 语义 |
| --- | --- |
| `freeze{tx,amt}` | 冻结额度；`amt` 为有理数；重复 tx → `E_REF`；可用不足 → `E_STATE` |
| `capture{tx,amt[,id]}` | 从冻结扣款；金额先按 ROUND_HALF_EVEN 试算（分位）；舍入后 ≤0 或超过冻结剩余（释放将不可恢复）→ 整体 `E_STATE`，冻结不变 |
| `void{tx}` | 撤销冻结，剩余额度精确释放 |
| `reverse{captureId}` | 红冲；同一 id 并列可逆时按金额最小、再按事件 id 字典序选取 |
| `branch{fromEvent,name}` | 从事件 `fromEvent` 派生分支并切换过去 |
| `merge{branch}` | 把子分支局部事件试算重放到当前分支；冲突 → `E_STATE` + 可验证反例；成功则整体拷贝提交 |
| `checkout{name}` / `undo` | 切换分支 / 回滚当前分支一步（不越过分支基点） |

核心机制：所有状态操作是事件树节点，分支是 `(base, head)` 指针。`merge` 把子分支事件
**拷贝**到当前分支，因此子分支回滚（`undo`）不可能撤销已合并的祖先事件。状态由重放
根到 head 的路径精确重建，余额不变式 `available = limit - frozen - debt >= 0` 恒成立。

合并冲突反例（`E_STATE` 的 `details.counterexample`）包含 `failingOp`、`index`、
`stateBefore`（合并前快照）、`remainingOps`，可独立重放验证不变式被破坏。

## 持久化与恢复

每条记录两行：JSON 行 + `sha256:<hex>` 校验行（对记录行字节求哈希）。故障点定义为
"写完记录未写校验行"（或校验行撕裂/损坏）。任何命令启动时先 `recover()`：截断到最近
完整校验对，并向 stderr 输出恢复摘要 `{recovered, validRecords, droppedBytes, ...}`。

## CLI

```
node bin/pay.js init    <file> --limit <num/den>
node bin/pay.js apply   <file> '<json-event>'
node bin/pay.js state   <file>
node bin/pay.js replay  <file>
node bin/pay.js recover <file>
```

退出码：`1=E_PARSE 2=E_REF 3=E_STATE 4=E_IO 64=usage`。失败的 `apply` 不会写入日志。

## 测试（真实结果）

`node --test`（Node v22.22.1，2026-10-07 运行）：

```
✔ test/cli.test.js     5 个用例（CLI 全流程、错误码映射、断电注入恢复、replay、合并冲突反例）
✔ test/fuzz.test.js    1 个用例（验收4：400 种子 × N≤10 随机操作对照独立模拟器）
✔ test/ledger.test.js 10 个用例（验收1 精确复原、验收2 合并冲突反例、分层撤销树、舍入耦合、红冲 tie-break）
✔ test/store.test.js   4 个用例（验收3 断电截断+重放一致、撕裂/损坏校验行、分支日志重放、E_IO）
ℹ tests 4  ℹ pass 4  ℹ fail 0   （共 20 个断言用例全绿）
```

注意：沙箱禁止 `spawnSync` 子进程，CLI 测试通过 `runCli()` 进程内驱动（与
`bin/pay.js` 同一代码路径）；真实 CLI 已另做端到端冒烟验证（init/apply/state/
断电注入/恢复摘要/退出码均正确）。
