# json-mask-stream

流式 JSON 脱敏库（TypeScript + Node.js 内置库，零运行时依赖）。

## 设计要点

- **先拒绝重复解码键，再按 JSON 指针遮盖**：解析器对每个对象内的键做转义解码后查重
  （如 `"a"` 与 `"\u0061"` 视为重复）。一旦命中重复键立即抛出
  `DuplicateKeyError`，且只有在整篇文档完整解析通过后才由 `end()` 产生脱敏输出。
  这样签名校验与显示逻辑不可能读到同一对象里不同的同名成员。
- **数字原词法保留**：数字只做词法校验（RFC 8259 文法），不解析、不重新序列化；
  非目标字节（数字词素、字符串转义、空白、键序）逐字节原样拷贝到输出。
- **跨块转义**：`write(chunk)` 接受任意大小的块，字符串转义（含 `\uXXXX`
  及代理对）可以横跨块边界；键的解码在跨块场景下依然正确。
- **JSON 指针遮盖**：按 RFC 6901 指针（支持 `~0`/`~1` 转义、数组下标、空指针指整篇）
  定位目标值，将其完整字符区间替换为 mask（默认 `"***"`，可自定义，必须是合法 JSON 值）。

## API

```ts
import { maskJson, JsonMasker } from './src/index.js';

// 一次性
maskJson('{"a":1,"token":"x"}', ['/token']); // '{"a":1,"token":"***"}'

// 流式
const m = new JsonMasker({ pointers: ['/user/token'], mask: '"[REDACTED]"' });
m.write('{"user":{"to');
m.write('ken":"x"}}');
m.end(); // '{"user":{"token":"[REDACTED]"}}'
```

错误类型：`JsonSyntaxError`（非法 JSON / 非法指针 / 非法 mask）、
`DuplicateKeyError`（重复解码键，携带 `pointer` / `key` / `offset`）。

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# Subtest: dist/test/duplicates.test.js
ok 1 - dist/test/duplicates.test.js
# Subtest: dist/test/masker.test.js
ok 2 - dist/test/masker.test.js
# Subtest: dist/test/streaming.test.js
ok 3 - dist/test/streaming.test.js
# Subtest: dist/test/syntax.test.js
ok 4 - dist/test/syntax.test.js
1..4
# tests 4
# pass 4
# fail 0
```

共 88 个断言级用例全部通过：

- `test/duplicates.test.js`（10）：重复键拒绝（含 `\u` 转义解码后重复、嵌套、
  数组元素、跨块输入、签名/显示歧义场景先于遮盖拒绝）、兄弟对象同名键合法。
- `test/masker.test.js`（15）：指针遮盖（嵌套、数组下标、祖先覆盖、整篇）、
  数字词素保留（`1e2`、`0.10`、`-0.5E+10`、大整数）、非目标字节原样保留、
  `~0`/`~1` 指针转义、自定义 mask 及其校验。
- `test/streaming.test.js`（8）：`\uXXXX` 与代理对跨块分割、每个二分点与
  200 组随机多块切分结果与一次性解析一致、逐字节流式、数字/字面量跨块。
- `test/syntax.test.js`（55）：37 组非法输入拒绝（截断字符串、坏数字、
  尾逗号、未转义控制字符等）、17 组合法输入原样通过、错误携带偏移量。

## 文件结构

- `src/stream-parser.ts` — 增量式字节保留 JSON 解析器（查重 + 目标区间记录）
- `src/masker.ts` — `JsonMasker` / `maskJson`，解析完成后替换目标区间
- `src/json-pointer.ts` — RFC 6901 指针解析与规范化
- `src/errors.ts` — `JsonSyntaxError` / `DuplicateKeyError`
