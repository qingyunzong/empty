# trace-genealogy

质量追溯系统：把批次加工链抽象为状态机，在持续导入历史批次文件时最小化合并等价的追溯视图，证明两版追溯规则等价（或给出反例），并支持按批次层级回滚错误导入。Node.js 22，仅标准库与 `node:test`，单机离线。

## 模型

- **状态** = 当前可追溯视图（当前所处批次的集合）；**符号** = `merge` / `split` / `test` / `ship`。
- 批次文件（JSONL）描述谱系 DAG：每个批次声明 `parents`、产生它的 `op`、以及该批次引入的 `defects`。
- 谱系即 NFA：`split` 对同一符号产生多个后继，子集构造把视图确定化为「当前批次集合」，每个 DFA 状态的输出 = 集合内批次缺陷的并（Moore 机）。
- **最小化**：按缺陷输出做划分细化，合并行为等价的视图；合并保持可达缺陷集合不变（导入时在线校验该不变式）。
- **未决状态**（`status:"pending"`）作为一等状态保留，绝不当作不可满足而剪枝。
- **等价证书**：两版规则各自最小化后求规范形（从起点按固定符号序 BFS 重编号），规范形一致 ⇔ 等价，证书为规范形的 SHA-256；不等价时在积图上 BFS，给出使可达缺陷集不同的**最短**符号串作为反例。
- **savepoint 层**：每次 `import` 追加一层到日志 `journal.jsonl`（`begin` / `record`×K / `commit`），**每条记录写后 fsync**，崩溃恢复点即每条记录 fsync 之后；恢复只重放完整层，层中撕裂的尾部被丢弃。`rollback N` 把日志截断到第 N 层末。

## 运行

```sh
node --test                 # 全部测试（含 ≤6 批全枚举对照）
node cli.js <cmd.jsonl> [--state <dir>]   # 默认状态目录 <cmd.jsonl>.state
```

命令（JSONL，每行一条；文件路径相对于命令文件）：

```json
{"cmd":"import","file":"batches.jsonl"}
{"cmd":"equiv","a":"rules-v1.jsonl","b":"rules-v2.jsonl"}
{"cmd":"rollback","layer":1}
```

每行命令输出一行 JSON；首行固定为启动恢复报告。退出码：`0` 成功；`4` 环状谱系 / 未知父批 / 层号空洞；`1` 其他错误；`2` 用法错误。

## 真实输出

`node cli.js examples/cmd.jsonl --state /tmp/s`（`examples/cmd.jsonl` 依次执行 import、import、equiv、equiv、rollback）：

```
{"cmd":"recover","recoveredTo":0}
{"cmd":"import","layer":1,"batches":6,"minStates":3,"recoveredTo":1}
{"cmd":"import","layer":2,"batches":2,"minStates":6,"recoveredTo":2}
{"cmd":"equiv","equal":true,"witness":null,"certificate":"2aac62f7f85b70bd3387eaa0ffee2b78d3279d25a8c636d7b7e853b7ac32578b","minStates":[3,3]}
{"cmd":"equiv","equal":false,"witness":["split"],"certificate":null,"minStates":[3,3]}
{"cmd":"rollback","recoveredTo":1,"minStates":3}
```

- `minStates`：导入后全局谱系确定化并最小化后的状态数。
- 第 4 行：`rules-v1.jsonl` 与 `rules-v2.jsonl` 同构但命名不同 → 等价，附证书。
- 第 5 行：`rules-v3.jsonl` 在 `cook-b` 上多了缺陷 `d9` → 最短反例 `["split"]`（split 后可达缺陷集 `{d1}` ≠ `{d1,d9}`）。

错误（退出码 4）：

```
$ node cli.js examples/cmd-cyclic.jsonl --state /tmp/s2 ; echo $?
{"cmd":"recover","recoveredTo":0}
{"error":"cyclic genealogy detected at batch \"a\"","kind":"CYCLIC_GENEALOGY"}
4
$ node cli.js examples/cmd-parent.jsonl --state /tmp/s3 ; echo $?
{"cmd":"recover","recoveredTo":0}
{"error":"batch \"lonely\" references unknown parent batch \"ghost\"","kind":"UNKNOWN_PARENT"}
4
```

崩溃恢复（导入第 1 层后，模拟在第 2 层写入中途 kill：日志尾部只有 `begin` 和一条 `record`，没有 `commit`）：

```
$ node cli.js c1.jsonl --state st        # 导入 layer 1 后进程被 kill 于 layer 2 中途
{"cmd":"recover","recoveredTo":0}
{"cmd":"import","layer":1,"batches":6,"minStates":3,"recoveredTo":1}
$ node cli.js c2.jsonl --state st        # 重启：状态等于最后完整层
{"cmd":"recover","recoveredTo":1}
```

## 测试

`node --test`（5 个文件，全部通过）：

- `test/genealogy.test.js` — 环 / 未知父批 / 未决状态保留。
- `test/dfa.test.js` — 同构谱系最小化同数且证书一致；最短反例（并暴力验证更短串全部不可区分）；split 非确定性与 merge 收敛。
- `test/journal.test.js` — 层中 kill 的恢复点、撕裂行、层号空洞、回滚截断。
- `test/cli.test.js` — 端到端：导入/等价/回滚、崩溃重启、退出码 4 三种错误、被拒绝的导入不留痕迹。
- `test/enumerate.test.js` — ≤6 批全枚举对照：1–5 批全部 DAG（1099 个）+ 6 批全部 32768 个 DAG + 500 个共享缺陷池随机谱系，逐一验证确定化/最小化后可达缺陷闭包不变、且无批次（含 pending）被丢弃。

## 布局

- `cli.js` — 命令行入口。
- `src/genealogy.js` — 记录校验、谱系图构建（环 / 未知父批检测）、NFA 构造。
- `src/dfa.js` — 子集构造、Moore 最小化、规范形证书、等价性与最短见证、可达缺陷闭包。
- `src/journal.js` — savepoint 层日志：逐条 fsync、恢复、回滚重写。
- `src/system.js` — 编排：恢复、导入（先校验后写日志）、等价比较、回滚；导入时在线校验可达缺陷闭包不变式。
- `examples/` — 示例批次文件、规则版本与命令文件。
