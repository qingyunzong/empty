# safety-interlock-monitor

单机离线安全联锁监控器。消费传感器事件流，用正则表达式描述禁止序列，
以三态语义给出监控结论，并通过 WAL + checkpoint 在进程崩溃后恢复到
确定的监控状态。仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 运行

```sh
node --test            # 运行全部测试
node cli.js mon.jsonl  # 处理 JSONL 脚本，逐条 status 输出 JSON 行
```

## 核心语义

**正则安全属性**：`init` 记录中的 `pattern` 描述禁止序列（bad trace 语言），
从轨迹起点整体匹配（前缀语义）。原子是事件名（裸词或 `"引号串"`），
支持 `.`（任意事件）、`|`、分组、`*`、`+`、`?`、`{m,n}`。

**三态结论**（对当前有限轨迹 u 与禁止语言 B）：

- `VIOLATION`：u ∈ B，违规已确认。**不可逆**——后续补录永不撤销。
- `SAFE`：u 的任何延拓都不可能落入 B（自动机已无可达接受态）。
- `UNKNOWN`：尚未违规，但未来事件仍可能补全违规。**UNKNOWN 永不输出
  UNSAT 证书，也永不被当作 SAFE**。

**宏步与歧义**：同一 `batch` 中的事件视为同时到达，按固定 tie-break
（`id` 升序）组成宏步。若批内事件的某种排列会得出不同结论，则
`ambiguous=true`（粘滞）。批大小 ≤ 8 时枚举全部排列精确判定；
更大的批使用确定性采样（canonical / 逆序 / 轮转 / 固定种子洗牌 512 种）。

**WAL 与恢复**：每个批次落盘一条 WAL 记录 `{seq, events, hash}`
（追加 + fsync），`hash` 为该批处理后的状态哈希
（sha256 of `{seq, dfaKey, violation, ambiguous}`）。`checkpoint`
原子写入（tmp + rename）`{seq, hash, state}`。故障点即"已写 WAL、
未写 checkpoint"：`crash` 记录丢弃内存状态，从最近一致 checkpoint
重放 WAL 至最后完整批——恢复 seq 为最后完整批序号；末尾撕裂行被容忍，
中间损坏、序号空洞、哈希不匹配均为一致性错误。

## 输入格式（JSONL）

```json
{"type":"init","pattern":"open close open"}
{"type":"batch","events":[{"id":"e1","name":"open"}],"seq":1}
{"type":"checkpoint"}
{"type":"crash"}
{"type":"status"}
```

- `batch` 的 `seq` 可省略；若给出必须等于上一批序号 + 1。
- 事件必须含唯一 `id` 与字符串 `name`。

## 输出

每条 `status` 记录输出一行：

```json
{"state":"VIOLATION","ambiguous":true,"seq":2,"hash":"066d74..."}
```

## 错误（退出码 12）

- 序号空洞（脚本显式 seq 跳号，或 WAL 中 seq 不连续）
- 哈希不匹配（WAL 记录或 checkpoint 与重放状态不符）
- 宏步内重复事件 id

stderr 输出 `E_CONSISTENCY: ...`，进程以退出码 12 结束。

## 真实运行结果

`node --test`（Node v22.22.1，16 个测试全部通过）：

```
# tests 1
# pass 1
# fail 0
# duration_ms 1182.024277
```

`node cli.js mon.jsonl`（示例脚本：init → batch → checkpoint →
乱序敏感批 → crash → 恢复 → 补录）：

```
{"state":"UNKNOWN","ambiguous":false,"seq":1,"hash":"6552ca83..."}
{"state":"VIOLATION","ambiguous":true,"seq":2,"hash":"066d7447..."}
{"state":"VIOLATION","ambiguous":true,"seq":2,"hash":"066d7447..."}
{"state":"VIOLATION","ambiguous":true,"seq":3,"hash":"05d1efde..."}
```

第 2 行：批 `{close, open}` 按 tie-break 排序为 `close,open`，
轨迹 `open close open` 命中禁止模式；而 `open,close` 的排列会是
`SAFE`，故 `ambiguous=true`。第 3 行：crash 后从 checkpoint(seq=1)
重放 WAL 恢复到 seq=2，哈希与崩溃前完全一致。第 4 行：违规后补录
`reset` 不撤销结论。

## 验收对照（test/monitor.test.js）

1. 同批不同序导致不同结论 → `ambiguous=true`（测试 1）
2. 违规后补录不撤销（测试 3）
3. crash 于 checkpoint 前，恢复 seq 为最后完整批（测试 4–6，含撕裂尾部容忍）
4. n≤7 宏步与枚举全部批内排列交叉对照（测试 13，200 组随机用例）
5. UNKNOWN 永不输出 UNSAT 证书（测试 14–15）
6. 序号空洞 / 哈希不匹配 / 宏步内重复 id → 退出码 12（测试 7–12）

## 文件结构

- `src/regex.js` — 迷你正则引擎：解析 → Thompson NFA → 按需 DFA → 三态判定
- `src/monitor.js` — `SafetyMonitor`：宏步、tie-break、歧义检测、状态哈希
- `src/store.js` — WAL（追加 + fsync、撕裂尾部容忍）与原子 checkpoint
- `src/engine.js` — JSONL 脚本驱动与崩溃恢复重放
- `cli.js` — 命令行入口
- `mon.jsonl` — 示例脚本
