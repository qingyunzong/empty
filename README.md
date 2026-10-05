# domain-rule-containment

ASCII 域名规则库：解析/归一化域名规则，判定规则间的包含关系并给出反例，
并在小标签域上做了穷举对照验证。仅使用 TypeScript + Node.js 内置库
（`node:net`、`node:test`、`node:assert`），无任何第三方依赖。

## 规则语法与归一化

- 输入必须是 ASCII；任何非 ASCII 字符（含全角字符、百分号编码外的 Unicode）
  一律以「非法编码」拒绝。
- 大小写折叠为小写；单个尾点（根点）归一化去除：`ExAmPle.COM.` → `example.com`。
- 通配符 `*` 仅允许作为**完整的最左标签**，且其下**至少还有一层**：
  `*.example.com` 合法；`*`、`ex*.com`、`a.*.com` 均拒绝。
- 拒绝：空标签（`a..com`、`.example.com`、`example.com..`）、
  标签首尾连字符、非法字符（下划线、空格、`%` 等）、
  标签超 63 字符、域名超 253 字符。
- 拒绝 IP 冒充域：纯数字四段（`1.2.3.4`、`999.1.2.3`）或 `net.isIPv4`
  判定为 IPv4 的输入，包括通配规则的基底（`*.1.2.3.4`）。

## 匹配语义

- 精确规则 `example.com` 只匹配其自身。
- 通配规则 `*.example.com` 只匹配**恰好低一层**的域名（`a.example.com`），
  不匹配 apex（`example.com`）本身，也不匹配更深层（`a.b.example.com`）。

## 包含关系

`contains(a, b)` 表示 a 匹配的域名集合 ⊇ b 匹配的集合：

| a \ b        | exact(D2)            | wildcard(B2)          |
|--------------|----------------------|-----------------------|
| exact(D1)    | D1 === D2            | 永不成立（无限集）     |
| wildcard(B1) | D2 恰为 B1 低一层     | B1 === B2             |

`counterexample(a, b)` 在 a ⊉ b 时返回一个被 b 匹配但不被 a 匹配的具体域名
（如 `contains("example.com", "*.example.com")` 的反例为 `x.example.com`），
包含时返回 `null`。`relate(a, b)` 给出 `equal | superset | subset | disjoint`
四分类（该语义下不存在部分相交）。

## 穷举对照

测试中以字母表 `{a, b}`、1–3 层标签构造全部 14 个域名作为论域，
全部 14 条精确规则 + 6 条通配规则（基底 ≤ 2 层，保证见证不超出论域）
共 20 条规则两两组合（400 对），逐一验证：

- 符号化 `contains()` 与论域上的暴力枚举结果完全一致；
- 每个非包含对的 `counterexample()` 都是合法见证（被 b 匹配、不被 a 匹配）；
- `relate()` 与 `contains()` 自洽。

## API

```ts
import { parseRule, matches, contains, counterexample, relate } from "./src/index.js";
```

## 测试

```
npm test    # tsc 编译后用 node --test 运行 dist/test/**/*.test.js
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/**/*.test.js"
# tests 1        # 外层把测试文件计为 1 项；文件内明细如下
# pass 1
# fail 0

$ node dist/test/rule.test.js
# tests 41
# suites 5
# pass 41
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 234.430887
```

41 个用例全部通过：归一化 3、非法输入拒绝 20、匹配语义 3、
包含关系与反例 11、关系分类 1、小标签域穷举对照 3（覆盖 400 对规则组合）。
