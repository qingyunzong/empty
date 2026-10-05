# domain-rule-lib

ASCII 域名规则库：归一化、通配规则、规则间包含关系判定与反例生成、小标签域穷举对照。
纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 规则语义

两种规则形式（均先归一化）：

| 形式 | 例子 | 匹配集合 |
|---|---|---|
| 精确规则 | `example.com` | 仅 `example.com` 本身 |
| 通配规则 | `*.example.com` | 所有以 `.example.com` 结尾、且左侧至少还有一个标签的域名（任意深度），**不含** `example.com` 本身 |

## 输入归一化与拒绝规则（`src/domain.ts`、`src/rules.ts`）

归一化：

- **大小写折叠**：ASCII 大写折为小写（`ExAmPle.COM` → `example.com`）。
- **尾点归一**：恰好剥掉一个根尾点（`example.com.` → `example.com`）。

拒绝（带错误码）：

- `NON_ASCII`：任何码点 > 0x7F 的字符（非法编码，含 `。` 等形似字符），先于其他检查。
- `EMPTY_LABEL`：空标签——`a..b`、前导点、`.`、`example.com..`（剥一个尾点后仍剩尾点）。
- `INVALID_CHAR` / `BAD_HYPHEN`：标签字符集 `[a-z0-9-]`，连字符不得出现在首尾。
- `LABEL_TOO_LONG` / `NAME_TOO_LONG`：标签 > 63 字节、全名 > 253 字节。
- `IP_MASQUERADE`：按 inet_aton 语义可解析为 IPv4 的名字——点分四段（`1.2.3.4`）、
  短形式（`127.1`、`10.0.257`）、八/十六进制段（`0177.0.0.1`、`0x7f.0.0.1`）、
  单个 32 位数（`2130706433`）。IPv6 无法冒充：`:`/`[`/`]` 本就不是合法标签字符。
- `BAD_WILDCARD` / `WILDCARD_NO_SUFFIX`：通配符 `*` 只允许作为**完整的最左标签**，
  且其后**至少一层**后缀（`*.com` 合法；`*`、`*.*.com`、`a.*.com`、`f*o.com` 均拒绝）。

## 包含关系（`src/rules.ts`）

`includes(a, b)` 表示 b 的匹配集合 ⊆ a 的匹配集合。判定过程：

- **b 为精确规则**：`a ⊇ b` ⟺ a 匹配 b 的唯一域名。
- **b 为通配规则**（匹配集合无限）：a 必须也是通配规则，且 `a.suffix` 是
  `b.suffix` 的后缀（或相等）。

`relate(a, b)` 给出四值关系：`equivalent` / `includes` / `included-by` / `incomparable`。
本规则系统中 `incomparable` ⟺ 匹配集合不相交（穷举测试中作为不变量验证）。

**反例**：当 `a ⊉ b` 时 `counterexample(a, b)` 返回一个被 b 匹配但不被 a 匹配的具体域名
（b 精确时即其域名；b 通配时为 `<label>.<suffix>`，自动避开被 a 遮蔽的标签，如
`x.a.com` 对 `*.a.com` 的反例会跳过 `x.a.com` 取 `y.a.com`）。

## 小标签域穷举对照（`src/enumerate.ts`、`test/exhaustive.test.ts`）

在字母表 `{a, b}` 上枚举：规则深度 ≤ 3（精确 + 通配共 28 条），域名宇宙深度 ≤ 4（30 个）。

**完备性**：对深度 ≤ D 的规则，任何包含关系的破坏都有深度 ≤ D+1 的见证
（反例要么是 b 的精确域名，要么是 b 后缀前再加一个标签），因此深度 D+1 的
有限宇宙是**完备判定过程**而非抽样。对照内容：

1. 结构匹配器 `matches` 与独立实现的朴素标签数组匹配器 `naiveMatches` 在全部
   28×30 个组合上结果一致（差分测试）。
2. 符号包含判定 `includes` 与宇宙上的暴力包含在全部 28×28 = 784 对规则上一致。
3. 每对规则：包含 ⟺ 反例为 `null`；否则反例确实被 b 匹配、不被 a 匹配，且深度 ≤ D+1。
4. 关系三分性，且 `incomparable` ⟺ 在宇宙上无共同匹配（不相交）。

## 用法

```sh
npm test          # tsc 编译 + 运行全部测试
npm run build     # 仅编译到 dist/
node dist/src/cli.js '*.example.com' a.b.example.com   # 查询两条规则的关系与反例
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 `tsc`）。`npm test` 实际输出（摘要）：

```
ok 1 - case folding
ok 2 - trailing-dot normalization strips exactly one root dot
ok 3 - empty input and empty labels are rejected
ok 4 - non-ASCII (illegal encoding) is rejected before anything else
ok 5 - label charset and hyphen rules
ok 6 - length limits
ok 7 - IPv4 masquerades are rejected in all inet_aton forms
ok 8 - numeric-looking names that are NOT IPs are accepted
ok 9 - isIPv4Address unit checks
# tests 9 / # pass 9 / # fail 0

ok 1 - rule parsing: exact and wildcard forms
ok 2 - rule parsing: wildcard placement restrictions
ok 3 - rule parsing: domain validation still applies to both forms
ok 4 - matching: exact rules match only themselves
ok 5 - matching: wildcards need at least one extra label, any depth
ok 6 - inclusion: exact vs exact
ok 7 - inclusion: wildcard vs exact
ok 8 - inclusion: wildcard vs wildcard is suffix inclusion
ok 9 - counterexamples witness the non-inclusion
ok 10 - relation summary
# tests 10 / # pass 10 / # fail 0

ok 1 - universe sizes
ok 2 - differential: structural matcher agrees with naive label-array matcher
ok 3 - cross-check: symbolic inclusion == brute-force inclusion on all rule pairs
ok 4 - cross-check: counterexamples are valid exactly when inclusion fails
ok 5 - cross-check: relation trichotomy and incomparable ⟺ disjoint
# tests 5 / # pass 5 / # fail 0
```

合计 24 个测试全部通过（穷举对照覆盖 28 条规则 × 30 个域名、784 对规则）。

CLI 实测：

```
$ node dist/src/cli.js '*.a.com' '*.b.a.com'
relation: includes
counterexample to B ⊇ A: x.a.com

$ node dist/src/cli.js 'a.com' '*.a.com'
relation: incomparable
counterexample to A ⊇ B: x.a.com
counterexample to B ⊇ A: a.com

$ node dist/src/cli.js '1.2.3.4' '*.com'
rule A "1.2.3.4" rejected: IP_MASQUERADE — "1.2.3.4" parses as an IPv4 address
```
