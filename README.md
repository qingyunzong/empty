# proto-diff

协议测试 CLI：输入两个确定自动机（各 ≤30 状态、字母表有序、缺边进入拒绝汇），
求使二者行为不同的**最短词**（同长度按字典序最小），或在等价时输出**可达积状态证书**，
并用较短自动机的状态数为深度界枚举所有词进行核验。

转移携带**整数输出**与**8 位寄存器更新**；等价性在所有可达积配置
（控制状态对 + 双方寄存器估值）上比较：接受性、同名寄存器值、每条边上的整数输出。
若探索的积配置数超过状态预算（`--budget`），结果为 UNKNOWN，**不宣称等价**。

## 构建与测试

```sh
npm run build   # tsc -> dist/
npm test        # 编译并运行 node:test 测试
```

## 使用

```sh
node dist/src/cli.js <automatonA.json> <automatonB.json> [--budget N] [--verify-depth D]
```

退出码：`0` 等价；`1` 不等价（打印最短区分词与双执行轨迹）；
`2` UNKNOWN（预算耗尽，未建立等价）；`3` 用法或输入错误。

## 输入格式

```json
{
  "name": "client",
  "alphabet": ["a", "b"],
  "initialState": "q0",
  "initialRegisters": { "r": 0 },
  "states": {
    "q0": {
      "accepting": false,
      "transitions": {
        "a": { "next": "q1", "output": 1, "update": { "r": { "op": "add", "value": 1 } } }
      }
    }
  }
}
```

- `alphabet`：有序、无重复；该顺序即字典序。两个自动机必须使用相同字母表（同序）。
- `states`：1–30 个；`accepting` 缺省为 `false`。
- `initialRegisters`：声明寄存器及初值（整数 0–255，8 位）。两机须声明同名寄存器。
- 转移：`next`（目标状态）、`output`（整数，必填）、`update`（可选）。
  更新写法：`{ "r": 5 }`（置位）或 `{ "r": { "op": "add|sub|set|xor|and|or", "value": n } }`，
  结果按 8 位回绕（mod 256）。
- **缺边**：未声明的 (状态, 符号) 进入隐式拒绝汇——非接受、无输出、寄存器不变、自环。

## 示例

```sh
node dist/src/cli.js examples/equiv-a.json examples/equiv-b.json   # EQUIVALENT + 证书 + 枚举核验
node dist/src/cli.js examples/diff-a.json examples/diff-b.json     # NOT EQUIVALENT + 最短词 a b + 双轨迹
```

## 语义说明

- 等价 = 所有可达积配置上：接受性一致 ∧ 同名寄存器值一致 ∧ 每个符号的边输出一致
  （缺边输出为"无"，与任何整数输出都不同）。
- BFS 按 (长度, 字典序) 枚举词，首个反例即最短且字典序最小的区分词；
  区分原因可能是 `acceptance` / `output` / `register`。
- 等价时输出全部可达积配置作为证书，并枚举长度 ≤ 较短自动机状态数的所有词
  重放两机核验（可用 `--verify-depth` 覆盖深度）。
