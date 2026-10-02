# repro-dag

实验复现管理器：把实验步骤登记为因果 DAG，缓存运行结果，更正某个步骤时
只失效其受影响后代，证据证书构成可从根验证到叶的哈希链，删除用 tombstone，
gc 仅回收所有运行者都确认不可达的节点。Node.js 22，仅标准库。

## 数据模型

- **节点**：`{id, deps, inputHash, codeVersion, cert, tombstone}`，依赖边构成因果 DAG。
- **缓存键**：`sha256({id, codeVersion, inputHash, ancestors})`，其中 `ancestors`
  为全部传递依赖的 `{id, key}` 拓扑有序向量（祖先向量）。任一祖先的代码版本或
  输入哈希变化都会改变后代的键。
- **证据证书**：哈希链段 `{prev, hash}`。`prev` 为所有依赖证书哈希排序后的哈希
  （根为 `GENESIS`），`hash = sha256(prev|id|inputHash|codeVersion)`。
  `audit` 按拓扑序从根到叶逐段重算并比对。
- **失效**：`invalidate` / 重复 `add` 更新节点时，精确删除该节点及其全部传递
  后代的缓存项，并按拓扑序重链受影响子树的证书；兄弟与旁支不受影响。
- **删除**：`tombstone` 仅打标记，记录保留以维持存活的证书链；`gc` 仅当
  **所有** 已注册运行者都在 `confirmations` 中确认该节点不可达、且无存活节点
  仍依赖它时才物理移除。

## 错误码

`CYCLE`（加边成环/自依赖）、`MISSING_INPUT`（依赖或目标不存在、节点已墓碑化）、
`BAD_CERT`（登记的证书与重算不符）。CLI 以 JSON 输出到 stderr 并以退出码 1 失败。

## CLI

```sh
repro-dag <add|run|invalidate|audit|gc|tombstone|register-runner> [--state P] [--file F]
```

JSON 输入来自 `--file` 或 stdin，结果输出到 stdout，状态持久化在 `--state`
（默认 `./repro-dag-state.json`）。

```sh
echo '{"id":"raw","deps":[],"inputHash":"h0","codeVersion":"v1"}' | repro-dag add
echo '{"id":"clean","deps":["raw"],"inputHash":"h1","codeVersion":"v1"}' | repro-dag add
echo '{}' | repro-dag run                       # 首次：全部计算
echo '{}' | repro-dag run                       # 缓存命中：零重算
echo '{"id":"raw","inputHash":"h0-fix"}' | repro-dag invalidate   # 只失效 raw 及其后代
echo '{}' | repro-dag audit                     # 校验根到叶的证书链
echo '{"id":"r1"}' | repro-dag register-runner
echo '{"id":"old"}' | repro-dag tombstone
echo '{"confirmations":{"r1":["old"]}}' | repro-dag gc
```

`add` 可选携带 `cert` 字段做登记校验；省略时自动计算并存储。

## 测试

```sh
node --test
```

覆盖验收标准：随机 ≤20 节点 DAG 的失效集与反向 BFS + 拓扑枚举双重参考比对
（50 个种子）；改叶不影响兄弟；环/缺输入/坏证书报固定错误码；gc 前后 audit
结果一致；序列化往返；CLI 端到端（进程内注入 I/O，与 bin 包装同一代码路径）。
