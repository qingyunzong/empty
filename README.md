# policy-intersect-cli

策略 CLI：计算两份 URL 源规则的交集，并对重定向链做有限状态等价判定。
TypeScript 编写，运行时仅使用 Node.js 内置库（零 npm 依赖）。

## 规则模型

```json
{
  "name": "A",
  "protocols": ["https"],
  "ports": [443],
  "exactDomains": ["status.example.com"],
  "wildcardDomains": ["*.example.com"],
  "allowSubdomains": ["api.partner.net"],
  "excludeSubdomains": ["evil.example.com"],
  "maxRedirects": 2
}
```

- `protocols` / `ports`：非空列表（缺省 `["http","https"]` / `[80,443]`）。
- `exactDomains`：精确匹配的域。
- `wildcardDomains`：通配根域，只匹配**严格子域**（`*.example.com` 匹配
  `a.example.com`，**不包含根域** `example.com` 本身）。可写 `*.root` 或 `root`。
- `allowSubdomains`：额外允许的子域集合（精确匹配）。
- `excludeSubdomains`：排除子域集合，**排除优先于一切允许**。
- `maxRedirects`：重定向次数预算（非负整数）；`null` 或缺省 = 预算未闭合。

URL 匹配 = 协议 ∈ protocols ∧ 端口 ∈ ports ∧ 主机匹配 ∧ 主机 ∉ 排除集。
未显式写端口时按协议默认端口（80/443）归一。

## 命令

```sh
npm run build                       # tsc 编译到 dist/（需要全局 tsc）
node dist/src/main.js intersect A.json B.json
node dist/src/main.js equiv A.json B.json
node dist/src/main.js match A.json https://api.example.com/
```

### intersect

输出规范（canonical）交集规则、见证 URL（`witness`，被两份源规则与交集同时
接受），以及两级小域枚举对照：

- `urlCrossCheck`：在由两份规则派生的有限小域（主机/协议/端口笛卡尔积）上
  逐点验证 `match(I,u) === match(A,u) && match(B,u)`；
- `chainCrossCheck`：在小域上**全链枚举**（重定向深度 ≤ min(预算, 3)），验证
  交集在每跳都满足两份策略：`accepts(I,c) === accepts(A,c) && accepts(B,c)`。

交集为空是**明确禁止**的：输出 `status: "empty-intersection"` 及原因，
退出码 2。主机集合交集按符号计算：exact∩exact、exact∩wildcard（双向）、
wildcard∩wildcard（可比较根域取较深者），再减去两边排除集的并；
预算取 `min`（任一侧未闭合则结果未闭合）。

### equiv

策略 P 的重定向链语义编译为有限自动机：状态 `q0..qB`（已消耗重定向数，
B = maxRedirects）+ `dead`；字母表为 URL 的 match/no-match 分类；所有 `qi`
均为接受态。因此：

- 两边预算均未闭合（`maxRedirects: null`）→ 返回 **`unknown`**；
- 匹配谓词相同且预算相同 → 返回**有限状态等价证明**（canonical 形式一致 +
  小域 URL 逐点核对 + 小域全链枚举核对，均 0 分歧）；
- 匹配谓词不同 → 返回**最短区分链**：长度 1（0 次重定向）的单 URL 链；
- 谓词相同但预算不同 → 最短区分链为 `min(B1,B2)+1` 次重定向、每跳都落在
  共同匹配集中的链，并由全链枚举确认更短链无分歧。

## 测试

```sh
npm test        # tsc 编译 + node --test（node:test / node:assert，内置库）
```

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：**4 个测试文件全部通过，34/34 个断言测试通过，0 失败**
（model 9、intersect 13、chains 8、cli 4）。

示例命令实测（`examples/` 中的规则）：

| 命令 | 结果 |
| --- | --- |
| `intersect rule-a.json rule-b.json` | exit 0；交集 = 通配 `api.example.com` + 精确 `status.example.com`、`api.partner.net`，排除 `staging.api.example.com`，预算 2；见证 `https://api.partner.net:443/`；URL 对照 12/12、全链对照 258 条链 0 分歧 |
| `intersect rule-a.json rule-c-disjoint.json` | exit 2；`empty-intersection`（无共同协议/端口/主机），明确禁止 |
| `equiv rule-a.json rule-a.json` | `equivalent`，有限状态等价证明（budget=2，258 条链 0 分歧） |
| `equiv rule-a.json rule-b.json` | `not-equivalent`；最短区分链 `[https://api.example.com:443/]`（0 次重定向，仅 A 接受——B 的通配不含根域 `api.example.com`） |
| `equiv rule-a.json rule-b-unclosed.json` | `unknown`：B 的预算未闭合 |

## 目录结构

- `src/model.ts` — 规则模型、校验、规范化、匹配语义
- `src/intersect.ts` — 交集计算、空交集错误、见证 URL
- `src/enumerate.ts` — 有限小域构造与 URL 级对照
- `src/chains.ts` — 链接受语义、全链枚举、等价证明/最短区分链
- `src/cli.ts` / `src/main.ts` — 命令分发（纯函数 `runCli`）与进程入口
- `test/` — `node:test` 测试（编译后由 `node --test` 运行）
