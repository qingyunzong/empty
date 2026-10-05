# amount-parse-edit

中文金额（亿 / 万 / 至多两位小数）解析、格式化逆函数与增量编辑库。
TypeScript 编写，运行时仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零第三方依赖。

## 文法

```
amount  := intPart ('.' frac{1,2})?
intPart := (digits{1,4} unit)* digits{0,4}     ; 有单位时
         | digits{1,}                          ; 无单位纯整数（不限长）
unit    := '亿' | '万'                          ; 必须递减：亿 > 万，重复拒绝
```

- 带单位的段强制 1–4 位（值 ≤ 9999），因此各段量级互不重叠、段间无进位，
  每个十进制位恰好落在至多一个段的覆盖范围内 —— 这是"每位来源"精确映射的基础。
- 零占位不改变量级：`0001万` = 1万，`1万0005` = 10005；末段超过 4 位即拒绝，
  零无法把量级顶高。
- 小数 1–2 位：`.5` = 50 分，`.05` = 5 分。

## 解析 `parseAmount(text)`

返回 `{ cents, tokens, segments, fraction, digits }`：

- `cents: bigint` —— 整数分。
- `tokens` —— 词法 token，保留原字节（`raw`）、字符区间与 UTF-8 字节区间。
- `segments` —— 整数段，含数字 token 与单位 token（单位来源）、量级 `scale`、缓存值 `value`。
- `digits: DigitSource[]` —— 分的每一位 `{ place, char, sources }`；
  `sources` 为决定该位的原 token（数字段 + 单位），隐式零为空数组。

非法输入抛 `ParseError`，`code` 区分：`INVALID_CHAR` / `NO_DIGITS` /
`MISSING_DIGITS_BEFORE_UNIT` / `SEGMENT_TOO_LONG` / `DUPLICATE_UNIT` /
`UNIT_ORDER` / `MISSING_FRACTION` / `FRACTION_TOO_LONG` / `UNEXPECTED_TOKEN`。

## 格式化逆函数 `formatAmount(cents)`

在定义域 `[0, 9999亿9999万9999.99]` 上是 `parseAmount` 的逆：

- `parseAmount(formatAmount(c)).cents === c`
- `formatAmount(parseAmount(formatAmount(c))) === formatAmount(c)`（规范形幂等）

规范形：非零段才输出；高位段存在时低位非零段零占位补满 4 位（`1亿0005`）；
小数去尾零（`0.50` → `0.5`）。域外抛 `RangeError`。

## 增量编辑 `AmountDocument`

```ts
const doc1 = AmountDocument.create("12亿345万6789.01");
const doc2 = doc1.setSegmentDigits("wan", "9999"); // 新快照
doc2.digitAt(6);  // 查询该金额位由哪些原 token 决定
doc1.cents;       // 旧快照不变
```

- 不可变文档：编辑返回新文档，旧快照永不改变；非法编辑抛 `EditError`，不发布新快照。
- 增量词法：编辑点之前的 token 原样复用，之后的仅平移偏移量。
- 增量重算：仅重算被编辑段的 `value`，其余段复用缓存值（编辑点前的段对象 `===` 同一），
  总分由缓存段值求和。
- `setFraction("05" | null)` 设置 / 删除小数段。

## 测试

```
npm test    # tsc 编译 + node --test
```

- `test/acceptance.test.ts` —— 边界与非法串穷举验收：合法语料按文法组合枚举
  （约 8000 例，期望值由独立参考实现计算），非法语料按错误类别全组合枚举。
- `test/parse.test.ts` —— 手写边界表、每位来源精确定位、零占位语义。
- `test/format.test.ts` —— 逆函数往返（边界表 + 3000 随机分）与规范形幂等。
- `test/document.test.ts` —— 增量编辑、结构共享、位来源查询、错误编辑不发布。
- `test/fuzz.test.ts` —— 3 个种子 × 400 步随机编辑，每步与完整解析逐位映射核对，
  并校验全部历史快照不变。

实际运行结果见 `TEST_RESULTS.md`。
