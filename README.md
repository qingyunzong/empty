# PLC 包装线控制命令线性化核验

包装线 PLC 把急停、光电、气缸完成事件先落本地 append-only 日志，再离线判定
控制命令历史是否可线性化。纯 Node.js 22 标准库，无第三方依赖，测试使用
`node:test`。

## 运行

```sh
node --test
```

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/log.js` | Append-only 日志；序号空洞抛 `ERR_GAP`，同源时间倒挂抛 `ERR_CLOCK` |
| `src/prng.js` | mulberry32 可重放随机性（同种子同序列） |
| `src/interleave.js` | 候选交错：按 `ts` → src 优先级（safety > photoeye > cylinder > plc）排序，同刻同层事件用种子化 Fisher-Yates 打乱 |
| `src/machine.js` | 设备状态机（READY / ESTOPPED / CYL_OUT）与命令-确认事件映射 |
| `src/inject.js` | 故障注入 drop / dup / delay；每次注入以 `kind: 'injection'` 记录追加进日志 |
| `src/replay.js` | 确定性重放器：把（可能注入过的）事件流按规范交错折进状态机 |
| `src/verify.js` | 核验器：记忆化 DFS 搜索合法交错，产出判定、最小违反前缀、最小证书 |
| `src/reference.js` | 指数级参考枚举器（无记忆化，枚举全部排列 × 确认分配），作为测试基准 |
| `src/worker.js` | 一致性检查 worker：随机历史同时跑核验器与参考枚举并比对 |

## 判定语义

输入 history：`ops: [{cmd, start, end, args}]`、`events: [{id, ts, src, kind}]`、`seed`。

一条交错合法当且仅当：

1. 满足实时序（`op_i.end <= op_j.start` ⇒ `i` 在 `j` 前）；
2. 满足设备状态机约束（如 `reset` 仅在 ESTOPPED 可用）；
3. 每个 op 配对一条**不同**的确认事件，类型匹配且 `ts ∈ [start, end]`。

判定三值，**UNKNOWN 不等同违反**：

- `LINEARIZABLE` — 存在合法交错（返回 witness）；
- `VIOLATION` — 每个已完成 op 都有区间内的确认候选，但仍无任何合法交错，
  日志确凿不一致；返回最小违反前缀与最小证书；
- `UNKNOWN` — 证据不足：存在缺 `end` 的 op，或某已完成 op 没有任何区间内
  确认事件。缺确认是"不知道"，不是"违反"。

**最小违反前缀**：规范时间线上最短的前缀，其本身已是 VIOLATION（再少一项就不是）。

**最小证书**：1-极小的违反项集合——删除其中任一单项（op 或事件），历史即
不再是 VIOLATION。由贪心删除迭代至不动点求得。

## 验收结果（真实运行，Node v22.22.1）

`node --test`：3 个测试文件全部通过（`# pass 3 / # fail 0`）。

`test/acceptance.test.js` 四个验收子测试全部通过：

```
ok 1 - 6 threads: verifier matches exponential reference enumeration
ok 2 -  duplicate e-stop injection replays to the same state
ok 3 - non-linearizable history returns minimal certificate and prefix
ok 4 - op without end stays UNKNOWN (and UNKNOWN is not VIOLATION)
```

1. **6 线程一致性**：6 个 `worker_threads` 各检查 30 条随机历史（共 180 条），
   记忆化核验器与指数级参考枚举判定完全一致（0 分歧），且 LINEARIZABLE 与
   VIOLATION 两种结果都真实出现。另用 6000 条随机历史做了更大规模核对：
   `{ LINEARIZABLE: 330, VIOLATION: 1935, UNKNOWN: 3735 }`，0 分歧。
2. **重复急停注入**：dup 注入后事件数 +1，重放终态与注入前相同（急停幂等），
   同种子重放逐迹一致；注入记录本身已入日志。
3. **最小证书**：两个重叠 `extend_cylinder`（中间无 retract）构造不可线性化；
   返回的证书满足"删除任一单项即通过"，前缀满足"少一项即不违反"。
4. **缺 end 的 op**：判定保持 `UNKNOWN`，且断言 `UNKNOWN !== VIOLATION`。

错误处理：`test/log.test.js` 覆盖 `ERR_GAP`（序号空洞，追加失败不污染日志）
与 `ERR_CLOCK`（同源时间倒挂，异源时钟互不影响）。
