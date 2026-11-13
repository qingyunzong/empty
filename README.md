# 电子发票行项精确对账

零依赖的 TypeScript 行项对账库。所有金额都是**最小货币单位**的整数，例如
CNY `12.34` 传入 `1234`。库会对齐期望数据与 OCR 数据中的行项、税率、折扣、
分税率税额和汇总，并返回最小不一致集合。

## 使用

```ts
import {
  createCurrencyPolicy,
  reconcile,
  type InvoiceDocument,
} from "dlks-de-0075";

const policy = createCurrencyPolicy({
  code: "CNY",
  lineTolerance: 0,       // 行金额允许的绝对误差，单位：分
  taxRateTolerance: 1e-5, // 13% 与 13.001% 可视为同一税率
  taxTolerance: 1,
  discountTolerance: 1,
  subtotalTolerance: 1,
  totalTolerance: 1,
});

const expected: InvoiceDocument = {
  currency: "CNY",
  lines: [
    { name: "拿铁", amount: 2800, quantity: 2, taxRate: 0.13, discount: 300, taxAmount: 325 },
    { name: "贝果", amount: 1200, quantity: 1, taxRate: 0.13, taxAmount: 156 },
  ],
  subtotal: 4000,
  discount: 300,
  tax: 481,
  total: 4181,
};

const ocr: InvoiceDocument = {
  currency: "CNY",
  lines: [
    { description: "贝果", amount: 1200, quantity: 1, taxRate: "13%", taxAmount: 156 },
    { description: "拿铁", amount: 2800, quantity: 2, taxRate: 0.13, discount: 300, taxAmount: 325 },
  ],
  subtotal: 4000,
  discount: 300,
  tax: 481,
  total: 4181,
};

const result = reconcile(expected, ocr, policy);

if (!result.ok) {
  // 仅包含最小集合中的差异；matches 给出同名行的精确配对。
  console.log(result.minimalInconsistencySet);
}
```

也可以直接对行数组对账：

```ts
import { reconcileLineItems } from "dlks-de-0075";

const result = reconcileLineItems(expected.lines, ocr.lines, policy);
```

## 行项模型

```ts
interface InvoiceLine {
  name?: string;                 // 也接受 description / label / text
  amount: number;                // 税前、折扣前净额，最小货币单位
  position?: number;             // 显式版面位置；缺省使用数组下标
  quantity?: number;
  unitAmount?: number;           // 也接受 unitPrice
  taxRate?: number | string;     // 0.13 / "13%" / 13 都表示 13%
  taxRateBps?: number;           // 1300
  taxAmount?: number;
  discount?: number | { amount?: number; rate?: number; rateBps?: number };
  discountAmount?: number;
  discountRate?: number;
  discountRateBps?: number;
  sku?: string;
}
```

文档级汇总支持 `subtotal`、`discount`、`tax`、`total`，也可放在
`summary` 或 `totals` 对象内。`taxes: [{ rate, amount }]` 用于分税率税额。

## 匹配与最小性

1. 行名先做 NFKC、去首尾空白、折叠空白并忽略大小写。设置
   `caseSensitiveNames: true` 可关闭大小写折叠。
2. 同名多行不会被简单按顺序配对。组内执行精确的最小费用指派，目标按字典序：
   先保证配对数量最大（即缺失/多余行最少），再最小化有差异的配对数，再最小化
   位置距离，最后最小化金额距离。因此 OCR 行乱序、同名同价、同名不同价都能
   稳定处理。
3. 行金额、数量、单价、税率、行税额、折扣金额/折扣率分别容差比较。
4. 汇总字段先做期望值/OCR 值比较；`checkSummaryArithmetic`（默认开启）还会检查
   每个文档自身的 `subtotal - discount + tax = total` 关系，但不会重复报告已被
   汇总差异覆盖的字段。
5. `taxes` 按税率容差配对，再比较税额。重复税率会先聚合成一个税率桶。

返回的 `discrepancies`（别名 `issues`、`minimalInconsistencySet`）只包含实际差异，
包括 `line-missing`、`line-unexpected`、`line-amount`、`line-tax-rate`、
`summary-total`、`tax-entry-amount` 等。`matches` 中包含原始行引用和索引。

## 币种策略

`createCurrencyPolicy()` 接受币种代码或部分覆盖对象：

```ts
const style = createCurrencyPolicy({
  code: "JPY",
  tolerance: (context) =>
    context.scope === "total" ? Math.max(1, context.lineCount) : 0,
});
```

内置 `CNY`、`USD`、`EUR`、`GBP`、`JPY`、`KRW`、`KWD`、`BHD`。未知的三字母
币种按 2 位小数创建严格策略。所有容差都是绝对最小货币单位；税率容差是小数
比例。`tolerance` 是金额类容差的便捷覆盖，`rateTolerance` 同时覆盖税率和折扣率。
未传策略时使用严格的 CNY 默认值（全部容差为 0），避免静默吞掉差异。

## 验证

```bash
npm run build
npm test
```

测试包含与实现无关的小规模穷举 oracle：对长度 0–3 的全部金额组合和两档容差，
以及长度 0–2 的金额/税率/折扣组合，枚举同名行指派，校验差异数量、位置距离和
金额距离均与最优解一致。
