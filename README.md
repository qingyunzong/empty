# incsp — 有向非负权图增量最短路

维护一个单源最短路结构，边增删后做**差分更新**而非全图 Dijkstra，
并支持等距路径中节点序列字典序最小的路径输出。

## 运行环境

Python 3.11+（仅标准库），开发验证环境为 Python 3.14。

## CLI 用法

从标准输入（或脚本文件）逐行读取命令：

```bash
python -m incsp              # 从 stdin 读命令
python -m incsp script.txt   # 从文件读命令
```

命令：

| 命令 | 语义 |
| --- | --- |
| `edge u v w` | 加/更新有向边 u→v，w 为 0..10^6 整数；重复边取最小权，记一次变更 |
| `rm u v` | 删边 u→v（不存在则为 no-op） |
| `src s` | 切换源点，清空缓存并全量重算一次 |
| `dist t` | 输出最短距离，不可达输出 `INF` |
| `path t` | 输出字典序最小的最短路节点序列（空格分隔）；不可达输出空行，exit 0 |
| `recomputed` | 输出上一次变更操作重新定值的节点数（供测试统计） |

规则：未知点自动创建；自环允许（不影响最短路）；负权、超界权重、
非法命令均输出错误到 stderr 并以 exit 2 终止。

示例：

```
$ printf 'src s\nedge s a 2\nedge a t 3\nedge s t 9\ndist t\npath t\nrm a t\ndist t\nrecomputed\n' | python -m incsp
5
s a t
9
1
```

## 增量算法（incsp/graph.py）

只增量维护 `dist[]`；`path` 是查询时在紧边子图上贪心选最小标号节点
（每步用 BFS 验证可达 t 且避开已访问点），因此并列最短路天然取字典序最小。

- **加边/降权**：若 `dist[u]+w < dist[v]`，从 v 出发做只降不增的
  Dijkstra 传播，仅触及距离真正变小的点。
- **删边**：若被删边对 v 不紧则无影响。否则：
  1. 候选集 C = 从 v 沿紧出边可达的点（只有它们可能受影响）；
  2. C 中"仍有支撑"的点 = 源点自身、或有来自 C 外的紧入边、或可从
     其他有支撑点沿紧边到达——即在新图中仍存在从 s 出发的紧路径；
  3. 受影响集 = C − 有支撑集（零权互相支撑的环会因支撑不落地而被
     正确判为受影响）；
  4. 仅对受影响集置 INF，从边界重新播种做 mini-Dijkstra。
  `last_recomputed` = 受影响集大小，恰好等于距离发生变化的节点数。

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖验收标准：

- **A** 加边出现更短路（含降权沿下游传播），recomputed 仅限受影响点
- **B** 删唯一桥后目标变 `INF`、path 为空，recomputed 等于受影响子树大小
- **C** 并列等长路径选字典序最小（含零权边、增删后仍成立）
- **D** 固定种子随机 50 次更新（edge/rm/src），与全量 Dijkstra +
  最短路枚举逐点对照 dist/path 一致，且每次 edge/rm 的
  `recomputed` 不超过距离实际变化的节点数（受影响上界）
- 语义：重复边取最小、未知点自动创建、自环、零权环、src 切换清缓存
- CLI：负权/超界/非整数权重 exit 2，不可达 path 空行 exit 0，
  100 链上加一条捷径 recomputed 远小于全图规模

## 真实测试结果

在仓库根目录实际执行 `python -m unittest discover -s tests -v`：

```
Ran 24 tests in 0.423s
OK
```

通过 24 / 失败 0（另用 500 步随机压力脚本对照全量 Dijkstra 验证通过，
该脚本未纳入测试套件）。
