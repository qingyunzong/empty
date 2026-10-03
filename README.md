# food-trace

离线单机批次谱系追溯库与 CLI：食品/化工厂从原料到成品的污染闭包增量重算与召回证书。
Node.js 22，仅标准库，测试使用 `node:test`。

## 事件模型（JSONL，每行一个事件）

| type      | 字段                          | 语义                                   |
|-----------|-------------------------------|----------------------------------------|
| `charge`  | `batch`                       | 投料，定义原料批次节点                 |
| `mix`     | `inputs[]`, `output`          | 合批，每个 input → output 建立因果边   |
| `split`   | `input`, `outputs[]`          | 拆批/分装，input → 每个 output 建边    |
| `link`    | `from`, `to`                  | 已存在批次间补边（如返工），可能成环   |
| `inspect` | `id?`, `batch`, `status`, `corrects?` | 检验；`corrects` 指向前次检验即补偿节点 |
| `scrap`   | `batch`                       | 报废，打墓碑                           |

谱系为 DAG：成环退出码 6；引用不存在批次（或重复定义批次、补偿指向不存在的检验）退出码 7。

## 污染规则（ruleVersion 1.0.0）

- 每批次的最新检验决定自身状态：`fail` 即自身污染；`pass` 之外的未知状态一律归一化为
  `unknown`，**不**当作不合格。
- 污染沿因果边向后传播：子批次污染 ⟺ 自身 `fail`，或存在未被墓碑阻断的污染父批次。
- 检验更正不删除历史：追加补偿检验节点，只对被更正批次的下游闭包做增量重算，
  闭包外节点状态不变。
- 墓碑（`scrap`）带时序：报废事件**之后**新建的边不传播旧风险（报废后新增分装不复活），
  报废前已存在的边照常传播；被报废批次自身的污染证据保留。
- 多个最早污染源（无传播中污染父节点的污染节点）按批号字典序排列。

## CLI

```sh
node bin/trace.js build <input.jsonl> [--state out.json] [--append existing.json]
node bin/trace.js correct --state state.json --batch B --status pass [--id C1] [--corrects I1]
node bin/trace.js recall --state state.json [--out cert.json]
node bin/trace.js verify --state state.json --cert cert.json
```

- `build`：解析 JSONL、校验（环 → exit 6，悬空引用 → exit 7）、全量计算并落盘状态。
- `correct`：追加补偿检验，增量重算污染闭包，输出变化节点。
- `recall`：输出召回证书：`ruleVersion`、`inputHash`（事件日志规范化的 SHA-256）、
  `boundary`（`sources` 最早污染源 + `affectedProducts` 受影响成品即污染叶子批次）、
  `contaminated`、`scrapped`。
- `verify`：从状态中的事件日志重放全量计算，与证书逐字段比对；一致 exit 0，否则 exit 1。

退出码：`0` 成功，`1` 证书不符，`2` 解析/用法错误，`6` 环，`7` 引用不存在批次。

## 测试

```sh
node --test
```

覆盖验收：随机小图与独立 DFS 枚举对照（300 种子）；单次更正仅变化闭包内节点；
报废后新增分装不复活旧风险；证书可重放验证且篡改可检出；CLI 退出码 6/7。
