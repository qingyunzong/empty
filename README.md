# perm-diff

权限策略差异分析 CLI：输入两个权限策略（合计至多 20 条规则）与有限的属性域，
找出使两个策略**决议不同**的**最小属性赋值**。

仅使用 TypeScript + Node.js 内置库（`node:fs`、`node:util`、`node:test`、`node:assert`），
无任何运行时依赖。离线环境下通过 `types/node-shims.d.ts` 提供所需的最小 Node 类型声明。

## 语义定义

- **策略**：有序规则列表 + 默认效果。每条规则为若干属性条件（`eq` / `ne` / `in`）与
  效果（`permit` / `deny`）。求值采用**首条命中规则生效**，无命中取默认效果。
- **部分赋值**：只指定一部分属性的取值。某策略在部分赋值下的"可能决议集"=
  所有补全（未指定属性取遍定义域）下决议的集合；集合为单例时称该策略被**确定**。
- **差异见证（witness）**：两个策略都被确定且决议不同的部分赋值。

## 最小性与枚举顺序

候选按如下规范顺序枚举，第一个见证即为最小见证：

1. **已指定字段少者优先**：k = 0, 1, …, n；
2. k 相同按**属性子集**的字典序（属性按声明顺序编号）；
3. 子集相同按**字段值序**：声明在前的属性为高位，值按定义域声明顺序。

## 判定结论

| 判定 | 含义 | 退出码 |
| --- | --- | --- |
| `DIFFER` | 找到最小差异见证 | 0 |
| `EQUIVALENT` | 搜索空间已穷尽，不存在差异（穷尽结论） | 1 |
| `UNDECIDED` | 预算耗尽而空间未穷尽（未决） | 2 |
| — | 输入非法或核对失败 | 3 |

预算 = 评估的候选赋值数量上限（默认 1,000,000；规格文件 `budget` 字段或
`--budget` 可覆盖，命令行优先）。

## 独立枚举核对

`src/verify.ts` 是对结果的**独立复核**，刻意不复用主搜索的实现
（主搜索用三值规则递归，核对用显式扩展枚举 + 里程表式生成器）：

- `DIFFER`：逐一枚举见证的所有补全，确认两策略处处确定且不同；
  并独立重枚举规范顺序中所有更小候选，确认均非见证（最小性）。
- `EQUIVALENT`：独立枚举全部全赋值，确认两策略决议处处相同。
- `UNDECIDED`：独立重枚举已检查前缀，确认无见证且空间确实未尽。

核对节点数超限（默认 2,000,000，`--verify-limit` 可调）时结论为 `skipped`。

## 输入格式

```json
{
  "attributes": [
    { "name": "role", "domain": ["admin", "user"] },
    { "name": "mfa", "domain": [false, true] }
  ],
  "budget": 100000,
  "policies": {
    "baseline": {
      "default": "deny",
      "rules": [{ "when": { "role": "admin" }, "effect": "permit" }]
    },
    "hardened": {
      "default": "deny",
      "rules": [{ "when": { "role": "admin", "mfa": true }, "effect": "permit" }]
    }
  }
}
```

- `attributes`：属性名唯一；`domain` 为非空数组，元素限字符串/数字/布尔且去重。
- `policies`：恰好两个策略；`default` 缺省为 `"deny"`；两策略规则合计 ≤ 20 条。
- 条件写法：标量简写为 `eq`；或 `{ "eq": v }` / `{ "ne": v }` / `{ "in": [v, …] }`；
  条件引用的属性必须已声明，值必须在定义域内。

## 使用

```sh
npm run build                              # 编译到 dist/
node dist/src/cli.js examples/differ.json  # 文本报告
node dist/src/cli.js examples/differ.json --json
cat spec.json | node dist/src/cli.js -     # 从标准输入读取
node dist/src/cli.js spec.json --budget 500000 --no-verify
```

## 测试

```sh
npm test    # tsc 编译 + node --test
```

实际测试结果见 [TEST_RESULTS.md](TEST_RESULTS.md)。
