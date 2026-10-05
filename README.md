# policy-intersect

策略 CLI：计算两份源规则的交集。TypeScript + Node.js 内置库（无第三方依赖）。

## 规则模型

每份源规则（策略）包含：

| 字段 | 含义 |
| --- | --- |
| `protocols` | 允许的协议（非空） |
| `exactDomains` | 精确域名 |
| `wildcardDomains` | 通配子域（可写 `*.example.com` 或 `example.com`）；**通配不包含根域**，`example.com` 本身不匹配，`a.example.com`、`a.b.example.com` 匹配 |
| `ports` | 端口集合；缺省/空 = 任意端口 |
| `allowSubdomains` | 允许子域集合；缺省/空 = 不限制。精确域的子域部分视为 `""` |
| `excludeSubdomains` | 排除子域集合 |
| `redirectBudget` | 重定向次数预算（非负整数）；`null`/缺省 = 无界 |

URL 匹配 = 协议命中 ∧ 端口命中 ∧ 至少一条域规则命中且子域部分通过 allow/exclude。

## 交集语义

- 协议：集合交；端口：集合交（任一侧不限则取另一侧）；预算：取 min（`null` 视为 ∞）。
- 域规则两两求交：exact∩exact、exact∩wildcard（精确域须为通配基域的真子域）、wildcard∩wildcard（保留更深基域，浅层 allow/exclude 按子域后缀平移翻译到深层基域上）。
- allow 取交（`null` 为全集）、exclude 取并；逐条做可满足性判定（allow 有限时通配规则可能无可用于域而被丢弃）。
- **空交集明确禁止**：输出 `empty-intersection` 及原因（协议不交 / 端口不交 / 无可行域规则），退出码 2。
- 非空时返回**规范化规则**（排序、去重、同域合并、剔除失效 allow 项）与**见证 URL**（运行时校验其同时被交集与两份源规则接受）。

## 小域枚举对照

从三份策略的域、allow/exclude 成员、协议、端口派生有限 URL 宇宙（含域外负例），逐一断言
`match(交集, u) === match(A, u) && match(B, u)`，输出 `smallDomainCheck`。

## 重定向链等价

链 = URL 序列（n 个 URL 含 n-1 次重定向）；每跳都须满足策略且重定向数不超过预算。
验证「交集策略」与「两份源策略逐跳合取」等价：

- 预算是有限值：状态空间 `URL宇宙 × 跳数(0..budget)` 有限，返回**有限状态等价证明**（逐跳谓词全宇宙一致 + 预算相等 ⇒ 对链长归纳等价），并对约减宇宙做**小域全链枚举**核对（枚举所有链逐条比较）。
- 不等价时返回**最短被两者不同接受的重定向链**（单 URL 谓词差异，或 min(预算)+1 次重定向的预算边界链）。
- 预算未闭合（两侧均无界 ⇒ 有效预算无界）：返回 `unknown`。

## 使用

```sh
npm run build
node dist/src/cli.js fixtures/ok.json     # 或 '-' 从 stdin 读取
```

输入：`{ "policyA": {...}, "policyB": {...} }`。退出码：0 正常；1 输入非法；2 空交集；3 内部对照失败。

## 测试

```sh
npm test    # = tsc 构建 + node --test dist/test/*.test.js
```

### 实际结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出摘要：

```
# Subtest: dist/test/chains.test.js      ok
# Subtest: dist/test/cli.test.js         ok
# Subtest: dist/test/enumerate.test.js   ok
# Subtest: dist/test/intersect.test.js   ok
# Subtest: dist/test/match.test.js       ok
# tests 5
# pass 5
# fail 0
# duration_ms 8275.247536
```

逐文件明细（`node --test-reporter=spec <file>`，共 32 个用例全部通过）：

- `match.test.js` 8/8：子域关系、规范化、通配不含根域、精确域、协议/端口、allow/exclude、非法输入拒绝
- `intersect.test.js` 10/10：通配交留深基域、exact∩通配、根域排除、不可交通配为空、协议/端口不交、allow 交 exclude 并、allow 平移、预算取 min、见证 URL
- `enumerate.test.js` 3/3：小域枚举对照一致；篡改交集（删通配规则、加端口）被检出
- `chains.test.js` 7/7：有界预算给出等价证明；双侧无界返回 unknown；单侧有界可闭合；篡改预算/谓词分别得到长度 4（预算边界）与长度 1 的最短反例链
- `cli.test.js` 4/4：ok 用例输出规范交集+见证+等价证明；空交集退出码 2；无界预算 unknown；stdin 读取

`fixtures/ok.json` 实际输出要点：宇宙 288 个 URL 全部一致；全链枚举 4680 条链 0 失配；
见证 `https://api.example.com/`；等价证明状态空间 `288 URLs x hop counts 0..2`。

注：本环境沙箱禁止 `spawnSync` 且吞没子进程管道 stdout，CLI 端到端测试改用异步
`spawn` + 临时文件重定向（见 `test/cli.test.ts` 注释）。
