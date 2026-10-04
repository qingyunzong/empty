# url-signing-canonicalizer

请求签名用的 URL 规范化库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert` / `Buffer`），零运行时依赖。

## 规范化规则

- **路径去点段**：按 RFC 3986 §5.2.4 `remove_dot_segments` 处理，且先解码后去点段
  （`%2e%2e` 会被识别为 `..`）。
- **百分号只解码非保留 ASCII**：仅解码 unreserved 集（`A-Z a-z 0-9 - . _ ~`）；
  保留字符（gen-delims / sub-delims）、其余 ASCII 与非 ASCII 字节保持编码，
  并将保留编码的十六进制统一为大写。
- **查询保留重复键并按键和值字节序排序**：按 `&` 切分，重复键全部保留，
  以 canonical 键字节序、再值字节序（UTF-8 字节比较）稳定排序；裸键（无 `=`）保持原形。
- **非法转义整次拒绝**：任何 `%` 后非两个十六进制字符即抛出
  `CanonicalizationError`，本次规范化无任何部分结果。

## API

- `canonicalizeUrl(raw)` → `Canonicalization`
  - `canonical` / `canonicalBytes`：规范字符串及其 UTF-8 字节（签名输入）。
  - `params`：原参数映射 —— 每个 canonical 参数对应原始序号与原始/canonical 双侧区间。
  - `canonToOrig` / `origToCanon`：规范字节 ↔ 原 URL 的双向偏移映射
    （被删除字符映射为 `-1`，合成字符如重排后的 `&` 映射为 `null`）。
  - `steps`：本次规范化的等价推导步骤（解码、大小写规整、去点段、排序、保留重复键）。
- `canonicalOffsetToOriginal(c, off)` / `originalOffsetToCanonical(c, off)`：双向映射访问器。
- `applyEditsAtomic(raw, edits)`：多处替换原子应用 —— 先校验全部区间（边界、不重叠），
  任一非法则整体拒绝、不做任何替换。
- `replaceParamValues(raw, c, [{canonIndex, newValue}])`：按原区间替换签名字段并重新规范化。
- `CanonicalizationCache`：以**原始 URL 字符串**为键缓存；规范后撞键但原始重复参数
  不同的 URL 各自持有独立条目，不会混同。
- `matchRoute(patterns, path)`：独立路由匹配器（与规范化器零共享代码），
  用于核对键等价不改变公开路由语义。

## 测试

```sh
npm test   # tsc -p tsconfig.json && node --test 'dist/test/*.test.js'
```

### 实际测试结果（Node v22.22.1, TypeScript 7.0.2）

```
✔ dist/test/cache.test.js         2 passed
✔ dist/test/canonicalize.test.js 13 passed
✔ dist/test/mapping.test.js       5 passed
✔ dist/test/matcher.test.js       4 passed
✔ dist/test/replace.test.js       5 passed
# tests 5  # pass 5  # fail 0   （共 29 个断言用例，全部通过）
```

覆盖点：去点段（含 `%2e` 编码点段）、仅解码非保留 ASCII、保留字符保持编码并大写、
非法转义整次拒绝、重复键保留与键值字节序排序、二次规范化幂等、双向偏移映射及往返一致、
原参数映射切片校验、按原区间替换与多处替换原子性、缓存不混同、独立匹配器路由语义等价。
