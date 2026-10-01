# dyntopo — 增量构建排序器

一个动态 DAG 上的增量拓扑排序器：CLI 逐行读取 JSONL 命令
（`add_node` / `add_edge` / `del_edge` / `del_node` / `order`），
`order` 输出当前可执行拓扑序。仅使用 Python 3.11 标准库。

## 运行

```sh
python -m dyntopo < commands.jsonl        # 从 stdin 读
python -m dyntopo commands.jsonl          # 或从文件读
python -m unittest discover -s tests -v   # 运行全部测试
```

## 命令格式

```json
{"op": "add_node", "node": "a"}
{"op": "add_edge", "from": "a", "to": "b"}
{"op": "del_edge", "from": "a", "to": "b"}
{"op": "del_node", "node": "a"}
{"op": "order"}
```

`order` 向 stdout 打印一个 JSON 数组：按层（level）输出、同层按节点 id
升序的扁平拓扑序，例如 `["fetch", "build", "test"]`。

## 排序语义（设计要点）

每个节点维护一个层级：`level(n) = 0`（无前驱），否则
`level(n) = 1 + max(level(p))`。输出 = 层级从小到大、同层 id 升序。
这使输出成为图的纯函数，天然满足：

- **确定性**：不依赖插入顺序或 hash 随机种子（有跨进程
  `PYTHONHASHSEED` 测试）。
- **删边只解锁后继**：删边只可能降低被删边后继子图的层级，无关节点的
  层级与相对顺序不变（增量重算只触及 `descendants*(v)` 受影响集）。
- **幂等**：重复 `add_node` / `add_edge` / `del_edge` 是无操作，
  不增加版本号（`version` 只统计有效变更）。

增量维护方式：`add_edge` 只沿后继传播层级上升；`del_edge` / `del_node`
只对受影响的后继集合做拓扑序重算；`del_node` 先级联删除所有关联边再重算。

## 环处理

`add_edge(u, v)` 若会成环（含自环），则：

- 该边**不被应用**，图保持最后一次无环快照；
- 识别受影响强连通分量：`descendants*(v) ∩ ancestors*(u)`，即所有位于
  经过新边的环上的节点；
- stdout 打印 `{"error": "cycle", "cycle": [...排序后的节点集...]}`，
  进程以 **exit 3** 退出。自环与多节点环的错误格式一致。

## 退出码

| code | 含义 |
|------|------|
| 0 | 全部命令成功应用 |
| 2 | 坏行：JSON 解析失败 / 未知 op / 缺字段或非法字段（stderr 输出详情） |
| 3 | add_edge 会成环（stdout 打印环上字典序最小节点集，状态保持无环快照） |
| 4 | 引用了未知节点（stderr 输出详情） |

所有错误在**任何变更之前**校验，失败命令不会部分应用；进程在第一个
错误处退出。空行被跳过。

## 库 API

```python
from dyntopo import DynamicTopoGraph, CycleError, UnknownNodeError

g = DynamicTopoGraph()
g.add_node("a"); g.add_edge("a", "b")
g.order()    # ['a', 'b']  扁平拓扑序
g.levels()   # [['a'], ['b']]  按层分组
g.version    # 有效变更次数（幂等无操作不计）
```

## 测试结果（真实运行记录）

命令：`python -m unittest discover -s tests -v`
环境：Python 3.14.4（代码仅使用 3.11 标准库），Linux。

```
test_incremental_adds_match_offline_kahn (test_dyntopo.TestAcceptanceA...) ... ok
test_no_hash_randomness_across_processes (test_dyntopo.TestAcceptanceA...) ... ok
test_delete_key_edge_unlocks_only_successors (test_dyntopo.TestAcceptanceB...) ... ok
test_unrelated_relative_order_preserved (test_dyntopo.TestAcceptanceB...) ... ok
test_cycle_cli_exit3_and_payload (test_dyntopo.TestAcceptanceC...) ... ok
test_longer_cycle_reports_scc_nodes (test_dyntopo.TestAcceptanceC...) ... ok
test_self_loop_library (test_dyntopo.TestAcceptanceC...) ... ok
test_two_node_cycle_library (test_dyntopo.TestAcceptanceC...) ... ok
test_repeated_add_edge_no_version_change (test_dyntopo.TestAcceptanceD...) ... ok
test_repeated_add_node_no_version_change (test_dyntopo.TestAcceptanceD...) ... ok
test_repeated_del_edge_no_version_change (test_dyntopo.TestAcceptanceD...) ... ok
test_empty_input_exit0 (test_dyntopo.TestCli...) ... ok
test_order_output_sorted_levels (test_dyntopo.TestCli...) ... ok
test_cascade_delete (test_dyntopo.TestDelNode...) ... ok
test_del_node_idempotent_unknown (test_dyntopo.TestDelNode...) ... ok
test_bad_json_exit2 (test_dyntopo.TestErrors...) ... ok
test_missing_field_exit2 (test_dyntopo.TestErrors...) ... ok
test_no_partial_application_cli (test_dyntopo.TestErrors...) ... ok
test_no_partial_application_library (test_dyntopo.TestErrors...) ... ok
test_unknown_del_node_exit4 (test_dyntopo.TestErrors...) ... ok
test_unknown_node_exit4 (test_dyntopo.TestErrors...) ... ok
test_unknown_op_exit2 (test_dyntopo.TestErrors...) ... ok

----------------------------------------------------------------------
Ran 22 tests in ~1.4s

OK
```

**22/22 通过，无失败、无跳过。**

验收对照：

- **A**：`test_incremental_adds_match_offline_kahn` 用固定种子生成 100 个
  随机小图（2–6 节点），逐步加边后每步校验线性扩展合法性，最终序与离线
  分层 Kahn 完全一致，并断言其属于回溯枚举出的全部拓扑序集合；另重放
  相同命令序列验证确定性。
- **B**：`test_delete_key_edge_unlocks_only_successors` /
  `test_unrelated_relative_order_preserved` 验证删关键边后只有后继子图
  的层级下降，无关节点相对顺序逐对保持不变。
- **C**：自环与二节点环在库层（`CycleError` 节点集）与 CLI 层
  （exit 3 + 相同 JSON 格式）行为一致，且状态保持无环快照。
- **D**：重复 `add_edge` 返回 False，`version` 与输出序均不变。
