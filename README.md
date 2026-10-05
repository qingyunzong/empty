# http-cache-key

HTTP 缓存键库（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

对 HTTP 请求的**方法、路径与指定头**做规范化后生成规范化缓存键；
重复头按 RFC 规则合并；含 CR/LF 的头一律拒绝；未参与键计算的字段
仍保留在审计信息中（含来源位置）。键相等当且仅当两请求在语义契约下
等价——该性质由穷举小请求组合的碰撞测试保证。

## 使用

```ts
import { buildCacheKey } from './src/cacheKey.js';

const result = buildCacheKey(
  {
    method: 'get',
    target: '/a/c/../b?x=%31',
    headers: [
      ['Accept', 'text/html'],
      ['accept', 'application/json'],   // 重复头 -> 合并为 "text/html, application/json"
      ['X-Trace-Id', 'abc'],            // 非键头 -> 忽略，但记入审计
    ],
  },
  { keyHeaders: ['accept'] }
);

result.key;        // 规范化键（长度前缀编码，单射）
result.normalized; // { method: 'GET', path: '/a/b', query: 'x=1', headers: [['accept', ...]] }
result.audit.ignored; // [{ kind: 'header', name: 'X-Trace-Id', value: 'abc', source: 'headers[2]' }]
```

## 规范化规则

- **方法**：必须是合法 token（RFC 7230），统一转为大写。
- **路径**（origin-form，可含查询串）：
  - 百分号编码规范化（RFC 3986 §6.2.2）：十六进制字母大写；非保留字符
    （`A-Z a-z 0-9 - . _ ~`）的三元组解码；其余逐字节保留；畸形 `%` 编码拒绝。
  - 点段移除（RFC 3986 §5.2.4）：`/a/./b`、`/a/c/../b` → `/a/b`。
  - 空路径归一为 `/`；连续斜杠、结尾斜杠、`%2F` 等保留字符**保持语义有效**，不合并。
  - 查询串仅做百分号编码规范化；参数顺序与重复保持原样；`?` 缺失与空查询视为不同。
- **键头**（`keyHeaders` 指定的头，大小写不敏感）：
  - 头名必须是合法 token，统一小写；值去除首尾 OWS。
  - 列表型头（默认）：按引号感知的逗号切分，项内空白折叠为单个空格，
    空项丢弃（RFC 7230 §7），以 `", "` 重新连接。
  - `cookie`：按 `;` 切分、逐对整理后以 `"; "` 连接（RFC 6265）。
  - 重复头按出现顺序合并（`,` 或 `; `）；`set-cookie` 不可合并，重复即报错。
  - 归一后无语义项的键头（如 `Accept: ,`）视为不存在。
  - 键头按头名排序后进入键，请求中键头出现顺序不影响键。
- **拒绝**（抛出 `CacheKeyError`）：
  - 任何头（无论是否参与键）的值含 CR/LF（防头注入/响应拆分）或其他控制字符；
  - 非法头名、非法方法、含空白/控制字符的请求目标、畸形百分号编码、
    不可合并头的重复出现。

## 语义契约与键的单射性

键序列化采用长度前缀编码（`ckv1|3:GET|4:/a/b|...`），可唯一解码，因此
**键相等 ⟺ 各规范化分量逐项相等**。在此之上定义语义等价：

> 两请求语义等价 ⟺ 方法（大小写不敏感）、路径（RFC 3986 规范化后）、
> 查询（百分号规范化后）以及每个键头的有序语义项列表全部相等；
> 非键头不影响等价性。

由此保证：**键相等 ⇒ 语义解释相等**（无碰撞），且 **语义相等 ⇒ 键相等**
（无碎片化）。两个方向都由穷举测试验证（见下）。

## 审计

`audit.ignored` 保留所有未参与键计算的头字段，含原始大小写的头名、
原值与来源位置（元组形式为 `headers[<索引>]`，记录形式为
`headers.<名称>[<索引>]`），供审计追溯。被忽略的字段同样要通过
CR/LF 与控制字符校验。

## 测试

```sh
npm test    # tsc 编译 + node --test（Node.js 内置测试运行器）
```

- `test/cacheKey.test.ts`：规范化、合并、拒绝、审计、单射性等单元测试（13 项）。
- `test/exhaustive.test.ts`：穷举碰撞检查。从方法 × 路径 × 查询 × 头组合的
  小字母表生成全部请求（4200 个），按键分组后：
  - 同组内：每个成员与组代表必须被独立语义判定器（`test/semantics.ts`，
    使用与库不同的算法实现）判为等价——否则即碰撞；
  - 跨组：704 个组代表两两（247,456 对）必须判为不等价——否则即碎片化。
  - 另对全部 4200 个请求验证：追加被忽略的头不改变键且进入审计。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 运行。

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"
✔ dist/test/cacheKey.test.js   (13 项单元测试全部通过)
✔ dist/test/exhaustive.test.js (穷举: 4200 请求, 704 个键, 247456 组间对)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ duration_ms ~1000
```

穷举测试日志：`exhaustive space: 4200 requests, 704 distinct keys,
247456 cross-group pairs checked`——未发现碰撞或碎片化。

## 限制与假设

- 仅处理 origin-form 请求目标（另有 `*`）；不处理 absolute-form/authority-form。
- 请求体不参与键；如需按键缓存 POST，请自行将体摘要加入键头或扩展。
- 方法大小写归一假定服务器不区分 `GET`/`get`（实际中普遍成立，但 RFC 层面
  方法理论上大小写敏感）。
- 路径点段移除假定服务器在路由前做等价的百分号解码（`%2E` ≡ `.`）。
