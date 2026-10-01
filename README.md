# incsp — 有向非负权图增量最短路

纯 Python 3.11+ 标准库实现。维护单源最短路（距离 + 字典序最小节点序列），
边增删时做差分更新（仅重算受影响子树），而非全图 Dijkstra。

## 运行

```bash
python -m incsp                 # 从 stdin 读命令
python -m incsp commands.txt    # 从文件读命令
python -m unittest discover -s tests -v   # 运行全部测试
```

## 命令

| 命令 | 语义 |
| --- | --- |
| `edge u v w` | 加有向边 u->v，整数权重 0..10^6；重复边取最小，逻辑上只记一条 |
| `rm u v` | 删除逻辑边 u->v（不存在则空操作） |
| `src s` | 设置/切换源点；切换会清空缓存，下次查询时惰性全量重算 |
| `dist t` | 输出最短距离；不可达输出 `INF` |
| `path t` | 输出等距中最字典序最小的节点序列（空格分隔）；不可达输出空行 |
| `recomputed` | 输出上一次更新重算的节点数（供测试断言增量性） |

其他规则：未知节点自动创建；自环允许（含 0 权自环）；负权或非法命令
打印错误并以 exit 2 退出；`INF`/空路径属于正常结果，exit 0。

## 设计要点

- 每个节点维护 `(dist, key)`，`key` 为最优路径的节点标签元组，堆序
  `(dist, key)` 直接给出字典序最小序列；松弛时跳过已在路径中的节点
  （只保留简单路径，0 权环不会导致不终止，且可证明不会漏掉最优简单路径）。
- 加边（或重复边压小权重）：仅从边端点做 Dijkstra 式前向松弛，
  `recomputed` 为实际改进的节点数。
- 删边：若被删边非紧边（`dist[u]+w != dist[v]`）则零重算；否则从 v 沿
  紧边闭包得到受影响子树 A，仅对 A 内节点以边界种子做多源 Dijkstra 重算，
  `recomputed = |A|`。
- `src` 切换置脏缓存，查询时惰性全量重算。

## 测试结果（真实运行）

命令：`python -m unittest discover -s tests -v`

- 环境：Python 3.14.4（向下兼容 3.11，仅用标准库）
- 结果：**15 通过 / 0 失败**（`Ran 15 tests ... OK`）
- 覆盖验收项：
  - A `AcceptanceA`：加边出现更短路（增量，recomputed==1）；重复边取最小
  - B `AcceptanceB`：删唯一桥后 `dist` 变 `INF`、`path` 为空，仅重算受影响子树
  - C `AcceptanceC`：等距并列选字典序最小序列；0 权边/自环/0 权环
  - D `AcceptanceD`：固定种子 50 次随机增删/换源，与独立全量松弛参照逐点
    对照 `dist`/`path` 一致，且删边后 `recomputed` 不超过受影响闭包上界
  - `CliTest`：CLI 输出、exit 0/2、文件输入、缓存清理
- 额外压力验证（非 unittest）：20 种子 x 500 步随机更新共 10000 次，
  与全量参照零失配，`recomputed` 全部在上界内。
