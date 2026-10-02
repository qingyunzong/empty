# calib-lab

计量实验室仪器校准证书签发判定库与 CLI（Node.js 22，仅标准库，`node:test`）。

## 模型

- 实体：标准器（`kind: "standard"`）、被校件（`kind: "dut"`）、测量点（`measure` 记录）。
- 域：量程档 `range`、等级 `grade`、环境档 `envClass`。
- 约束：溯源链无环（`link` 时拒绝成环）、标准器不确定度逐级优于被校对象、
  环境窗覆盖测量时刻且环境档匹配、标准器在测量时刻处于有效期、
  同一标准器不得被不同测量点并发占用（租约）。
- `root: true` 的标准器视为溯源链顶端（可直接溯源至国家基准）。

## 命令（库方法与 CLI 同名）

`add_artifact` / `link` / `unlink` / `measure` / `reserve` / `release` / `certify` / `audit`

- `reserve`/`release` 成对；重复释放或释放未知租约、并发占用均抛 `LEASE_STATE`。
- `unlink` 仅当下游无未决测量（未出证的测量点）时允许，否则抛 `PENDING_MEASUREMENTS`。
- `certify` 做不确定度传播（链上标准器方和根合成，k=2）+ 回溯分配标准器链，输出：
  - `CERT`：含链、合成不确定度、预算、SHA-256 哈希；
  - `REFUTE`：结构性矛盾，附最小核心（沿最接近成功的链取最小基数失败集）；
  - `INSUFFICIENT_EVIDENCE`：证据未齐（缺测量、缺环境窗等），绝不当 `REFUTE`；
  - `PENDING`：链可行但合成不确定度超预算（边界值 `U == budget` 判通过）。
- `audit` 重放证书：重算哈希与合成不确定度并复核全部链约束，
  输出 `VALID` / `TAMPERED` / `NOT_REPRODUCIBLE` / `INVALID`。

## 持久化

仅 `measure` 落盘（`src/store.js` 的日志）：
append 行 → fsync(log) → 写 `HEAD.tmp` → fsync → rename 为 `HEAD` → fsync(dir)。
每行带哈希链；恢复时只重放到 `HEAD` 提交的偏移，撕裂/未提交尾部被截断，
崩溃恢复不会出现半条 measure。

## 用法

```sh
node cli.js --dir data --script ops.jsonl     # 批量执行 {"cmd","args"} 行
node cli.js --dir data certify '{"point":"p1"}'
node cli.js --dir data audit --file cert.json
node --test                                    # 全量测试
```
