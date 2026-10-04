# taintcheck

上下文敏感的污点分析 CLI（仅使用 Go 标准库）。输入一个有限的控制流图（CFG）
与变量赋值，污点沿**数据依赖**与**条件分支（隐式流）**传播；清洗（sanitize）
只对**指定上下文**有效；循环通过**最小不动点**迭代处理。输出**每一条**泄露
路径（source → … → sink 的事实序列）。

## 构建与运行

```sh
go build -o taintcheck .
./taintcheck -f examples/leak.json        # 文本报告
./taintcheck -f examples/loop.json -json  # JSON 报告
cat examples/branch.json | ./taintcheck   # 从 stdin 读取
```

退出码：发现泄露为 `1`，无泄露为 `0`，输入/参数错误为 `2`。

## 输入格式（JSON）

```json
{
  "contexts": ["sql", "html"],
  "entry": "n0",
  "nodes": [
    {"id": "n1", "kind": "source",   "var": "user"},
    {"id": "n2", "kind": "assign",   "var": "q", "uses": ["user"]},
    {"id": "n3", "kind": "branch",   "uses": ["flag"]},
    {"id": "n4", "kind": "sanitize", "var": "q", "contexts": ["sql"]},
    {"id": "n5", "kind": "sink",     "var": "q", "contexts": ["sql"]}
  ],
  "edges": [{"from": "n1", "to": "n2", "label": "true"}]
}
```

节点语义：

- `source`：为 `var` 引入污点（`contexts` 缺省为全部上下文）。
- `assign`：`var := f(uses...)`，对 `var` 做强更新（重新赋常量可清除污点）。
- `sanitize`：仅从 `var` 的污点中移除 `contexts` 列出的上下文，其余保留。
- `branch`：`uses` 为条件变量；被其控制依赖的节点上的赋值获得隐式污点。
- `sink`：若 `var` 在 `contexts` 中任一上下文下带污点，则构成泄露。

## 分析算法

1. **控制依赖**：在反向 CFG 上求后支配者（最大不动点），取每个分支节点的
   直接后支配者 `ipdom`；从分支后继出发、不经过 `ipdom` 可达的节点即为该
   分支的控制依赖区域（隐式流区域）。
2. **数据流不动点**：状态为 `节点 -> 变量 -> 上下文集合`，从空状态出发做
   混沌迭代；所有传递函数单调，故收敛到**最小不动点**。每轮完整快照被记录，
   可用于核对状态展开（单调递增且末两轮相同）。
3. **泄露路径**：在不动点状态上构建溯源图（事实 -> 其来源事实），从每个
   受污染的 sink 事实反向枚举所有简单路径（无重复事实）至 source 事实，
   反转后即为一条泄露路径。

## 测试

```sh
go test ./...
```

测试用小图核对状态展开：线性泄露、匹配/不匹配上下文的清洗、分支隐式流、
循环最小不动点（迭代轮数、快照单调性、末轮不动）、菱形双路径、强更新清除、
输入校验错误。

实际运行结果（Go 1.27.1，linux/amd64，2026-10-05）：

```
$ go test ./... -count=1
ok  	taintcheck	0.005s
ok  	taintcheck/taint	0.005s
```

共 14 个测试（含 10 个解析错误子测试），全部通过。

## 示例

- `examples/leak.json`：线性数据依赖泄露（source → assign → sink）。
- `examples/sanitized.json`：对 sink 上下文做了匹配清洗，无泄露。
- `examples/branch.json`：条件变量带污点，分支内常量赋值经隐式流泄露。
- `examples/loop.json`：污点绕回边传播，3 轮达到最小不动点后报泄露。
