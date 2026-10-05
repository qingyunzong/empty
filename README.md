# url-signing-canonicalizer

TypeScript + Node.js 内置库实现的请求签名 URL 规范化库，无第三方依赖。

## 规则

- **路径去点段**：按 RFC 3986 §5.2.4 语义移除 `.` / `..`（含 `%2e` 编码形式），根处 `..` 钳位；保留首尾斜杠。
- **百分号解码**：仅解码非保留 ASCII（unreserved：`A-Z a-z 0-9 -._~`）；保留字节与非 ASCII 字节保持编码并统一大写十六进制；原始非 ASCII 字符按 UTF-8 编码。**非法转义（`%`、`%2`、`%GG` 等）整次拒绝**，抛出 `CanonicalizationError`，不产生部分结果。
- **查询**：保留重复键，按键字节序再按值字节序稳定排序；`a` 与 `a=` 区分。
- **返回值**：规范字节（`canonicalBytes`）、规范字符串、原参数映射（`params`，含原 URL 区间）、等价推导步骤（`steps`）、双向偏移映射（`map`）。

## API 概览

- `canonicalizeUrl(url)` → `{ canonical, canonicalBytes, canonicalPath, canonicalQuery, params, steps, map }`
- `map.canonicalToOriginal(off)` / `map.originalToCanonical(off)` — 规范字节 ↔ 原 URL 双向偏移映射
- `replaceOriginalIntervals(original, edits)` — 按原区间替换签名字段；多处替换原子生效，任一区间非法/重叠则整体拒绝
- `CanonicalizationCache` — 缓存键 = 规范形式哈希 + 原 URL 哈希；规范后撞键但原始重复参数不同（如 `?a=1&a=2` vs `?a=2&a=1`）不会混同
- `matchRoute(routes, path)` — 独立实现的匹配器（自带解码与点段处理），用于核对键等价不改变公开路由语义

## 测试

```
npm test    # tsc 编译 + node --test
```

实际结果（Node v22.22.1, tsc 7.0.2）：

```
ok 1 - dist/test/cache.test.js          # 3 pass
ok 2 - dist/test/canonicalize.test.js   # 31 pass（含二次规范化幂等、保留字符、非法转义拒绝）
ok 3 - dist/test/mapping.test.js        # 5 pass
ok 4 - dist/test/router.test.js         # 9 pass
# pass 48 / fail 0
```
