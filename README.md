# http-cache-key

HTTP 请求缓存键库。TypeScript 编写，仅依赖 Node.js 内置模块
（`node:crypto`、`node:test`、`node:assert`），零 npm 依赖。

## 安全不变量

> `buildCacheKey(a) === buildCacheKey(b)` ⟹ `a` 与 `b` 在缓存语义下可互换
> （以配置的 `varyHeaders` 为模）。

反向不保证：规范化是保守的，只折叠 RFC 保证语义无差别的差异；
语义相等但键不同是允许的（宁可多存，不可错并）。该不变量由
`test/exhaustive.test.ts` 用小请求空间全组合穷举验证（见下文）。

## 用法

```ts
import { buildCacheKey } from "./src/cache-key.js";

const { key, digest, audit } = buildCacheKey(
  {
    method: "get",
    path: "/a/./b?q=%7E",
    headers: [
      ["Accept", "text/html"],
      ["ACCEPT", "application/json"],   // 重复头 → 按规则合并
      ["X-Trace-Id", "abc"],            // 非 vary → 进审计，不进键
    ],
  },
  { varyHeaders: ["Accept"] },
);
// key    = '["http-cache-key/v1","GET","/a/b?q=~",[["accept","text/html,application/json"]]]'
// digest = sha256(key)（64 位十六进制，适合直接做存储键）
// audit.ignoredHeaders = [["X-Trace-Id", "abc"]]（原始大小写/值/顺序，来源可审计）
```

## 规范化规则

**方法**：校验为合法 token（RFC 9110 §5.1），统一折为大写。

**路径**（仅做 RFC 3986 保证语义不变的变换）：
- 解码未保留字符的百分号编码（`%7E` → `~`），其余编码十六进制统一大写（`%2f` → `%2F`，不解码保留字符）；
- 按 RFC 3986 §5.2.4 移除点段（`/a/x/../b` → `/a/b`，`%2E` 先解码再参与）；
- 空路径规范为 `/`；
- 查询串逐字节保留（参数顺序、重复参数均有语义），仅做同样的百分号规范化；
- 不改：尾斜杠、路径大小写、`%2F` 等保留字符编码。

**头**：
- 字段名校验 token 并折为小写（大小写不敏感）；
- 值去除首尾 OWS（空格/制表符），内部空白保守保留；
- 仅 `varyHeaders` 指定的头参与键（名称大小写不敏感）；
- 不同字段名之间的顺序无语义，按键内排序取规范形。

## 重复头合并规则

| 规则 | 适用头 | 行为 |
| --- | --- | --- |
| 逗号合并 | 默认（列表型字段，RFC 9110 §5.3） | 多行按序以 `,` 连接 |
| Cookie | `cookie`（RFC 6265 §5.4） | 多行以 `; ` 连接 |
| 元组保留 | `set-cookie`（不可合并） | 保留为有序数组，顺序有别 |
| 单例拒绝 | `host`、`content-length`、`content-type`、`authorization`、`user-agent`、`referer`、`expect`、`max-forwards`、`if-modified-since`、`if-unmodified-since` | 出现重复行抛 `ERR_DUPLICATE_SINGLETON` |

## 拒绝规则（抛 `CacheKeyError`）

- `ERR_HEADER_NEWLINE`：头值含 CR 或 LF（防请求走私/响应拆分）；
- `ERR_HEADER_CONTROL`：头值含其他控制字符（HTAB 除外）；
- `ERR_HEADER_NAME` / `ERR_METHOD_TOKEN`：非法 token。

## 审计来源

被 `varyHeaders` 排除的字段不进键，但以**原始大小写、原始值、原始顺序**
保留在 `result.audit.ignoredHeaders` 中；参与键的规范化结果在
`audit.usedHeaders` 中，二者共同构成完整审计轨迹。

## 穷举碰撞测试

`test/exhaustive.test.ts` 对小型请求空间做全组合枚举
（4 方法 × 19 路径 × 5 Accept 变体 × 3 X-Mode 变体 × 3 忽略头变体），
并用**独立实现的语义预言机**（WHATWG URL 做点段移除 + 按 RFC 重写的
百分号/头合并逻辑，不调用被测库）逐对验证：同键 ⟹ 同语义；
另在仅含 vary 头的子空间上验证双向等价（同语义 ⟺ 同键），
并验证每个请求的忽略头审计来源完整、其值不漏入键。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（`tsc`），npm 9.2.0。
`npm test`（= `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`）实际输出：

```
# Subtest: dist/test/cache-key.test.js
ok 1 - dist/test/cache-key.test.js
# Subtest: dist/test/exhaustive.test.js
ok 2 - dist/test/exhaustive.test.js
# tests 2
# pass 2
# fail 0
```

单元测试明细（24 断言全过，6 个分组：方法/路径/头合并/头拒绝/vary 与审计/键格式）：

```
# tests 24
# suites 6
# pass 24
# fail 0
```

穷举测试明细（诊断输出）：

```
# requests enumerated: 3420
# distinct cache keys: 324
# keys shared by >1 request: 324
# same-key pairs verified equivalent: 3420
# tests 3
# pass 3
# fail 0
```

即：3420 个请求归并为 324 个键，全部 3420 组同键对逐一通过独立语义
等价校验，未发现碰撞；审计与双向等价测试同样全部通过。

## 目录与脚本

```
src/cache-key.ts      库（规范化、合并规则、拒绝、审计、键与摘要）
src/node-shims.d.ts   Node 内置模块的最小类型声明（替代 @types/node）
test/cache-key.test.ts   单元测试
test/exhaustive.test.ts  穷举碰撞测试
```

- `npm test`：编译并运行全部测试
- `npm run build`：仅编译到 `dist/`
- `npm run typecheck`：仅类型检查
