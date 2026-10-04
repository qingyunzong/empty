# json-mask-pointer

流式 JSON 脱敏解析库（TypeScript，仅依赖 Node.js 内置模块）。

## 设计保证

1. **先拒绝重复解码键，再按 JSON 指针遮盖**
   同一对象内，解码后的键若重复（如 `"a"` 与 `"\u0061"`、`\uD83D\uDE00` 与
   字面 `😀`），立即抛出 `DuplicateKeyError`，且发生在产生任何遮盖输出之前。
   这样签名方与显示方永远读到同一个同名成员，不存在"签名验 A、显示读 B"
   的双生键歧义。被遮盖子树内部的重复键同样会被拒绝。

2. **数字原词法保留 / 非目标字节原样保留**
   遮盖通过对原始输入做字节区间拼接实现，从不重新序列化。合法输入中
   非目标的空白、键序、字符串转义形态（`\n`、`\u0041` 的原始写法）以及
   数字词法（`1e2`、`0.500`、`-0`、`1E+10`、`9007199254740993`）逐字节保留。

3. **跨块转义与重复键输入验收**
   `feed()` 接受任意分块；转义序列可跨越块边界（块尾为 `\`、`\u0041`
   被拆开、代理对跨块），扫描器状态在块间保持。重复键在键 token 解码
   完成时即刻快速失败（可能发生在 `feed()` 期间）。

## API

```ts
import { JsonMasker, maskJson } from 'json-mask-pointer';

// 一次性
const out = maskJson('{"a":1,"secret":"x"}', { pointers: ['/secret'] });
// => '{"a":1,"secret":"***"}'

// 流式分块
const m = new JsonMasker({ pointers: ['/user/ssn'], replacement: 'null' });
m.feed('{"user":{"ss');
m.feed('n":"123"}}');
const masked = m.end();
```

- `pointers`：RFC 6901 JSON 指针；`''` 选中根值；`~0`/`~1` 转义。
- `replacement`：拼接到遮盖区间的原始 JSON 文本，默认 `"***"`。
- 错误类型：`DuplicateKeyError`（含 `pointer`、`key`）、`JsonSyntaxError`
  （含 `offset`）、`InvalidPointerError`。

## 测试

```sh
npm test    # tsc 编译 + node --test（Node.js 内置测试运行器）
```

前置条件：Node.js >= 18，`tsc` 在 PATH 中（本仓库零 npm 依赖）。
实际测试结果见 [TEST_RESULTS.md](./TEST_RESULTS.md)。
