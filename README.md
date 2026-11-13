# Excel 合并单元格表头展开

可直接接入 TypeScript 工作表结构解析结果（二维单元格、`merges`、隐藏行列、公式缓存）并生成多级表头与数据行映射。

## 使用

```ts
import { buildTableStructure } from "./index.ts";

const table = buildTableStructure(
  {
    rows: [
      ["Sales", null, "Info", null],
      ["Q1", "Q2", "Name", "Name"],
      [{ formula: "=1+1", v: 2 }, 20, "Alice", "A"],
      [5, 50, "Carol", "C"],
    ],
    merges: ["A1:B1", "C1:D1"],
    hiddenRows: [3],
  },
  { headerRows: 2 },
);
```

结果中的列使用完整路径区分：

```ts
table.headers.map((column) => column.key);
// ["Sales / Q1", "Sales / Q2", "Info / Name", "Info / Name #2"]

table.rows[0].values;
// { "Sales / Q1": 2, "Sales / Q2": 20, "Info / Name": "Alice", "Info / Name #2": "A" }
```

`rows` 也可以直接作为第一个参数传入：

```ts
buildTableStructure(rows, { headerRows: 2 });
```

## 约定

- `mergedRanges` / `merges` 支持 `"A1:B2"`、`{ s: { r, c }, e: { r, c } }`、`{ startRow, startColumn, endRow, endColumn }` 等常见形式。对象坐标为 0-based，A1 字符串为 1-based。
- 任意两个合并区域有交集（包括完全重复）都会抛出 `MergedRangeOverlapError`。
- 表头空单元格不会跨列继承；只有位于合并区域内的单元格才使用该区域的锚点值。垂直合并的同一标签只生成一个路径层级。
- 隐藏行不会成为表头层级，隐藏行列也不会进入数据；`rowIndex` / `columnIndex` 始终保留工作表原始坐标。
- 公式单元格使用 `cachedValue` / `v` / `result` / 工作表 `formulaCache`，绝不把公式表达式当作值。
- 重名列用完整 `path` 和 `key` 区分；完整路径仍完全相同（例如同名叶子来自同一父级）时追加 `#2` 等稳定后缀。
- 默认跳过完全为空的数据行，可通过 `skipEmptyRows: false` 保留。

## 主要选项

| 选项 | 说明 |
| --- | --- |
| `headerRows` | 表头物理行数，或显式 0-based 行下标数组 |
| `headerRowCount` | `headerRows` 数字形式的别名 |
| `headerStartRow` | 表头起始物理行 |
| `dataStartRow` | 数据起始物理行，优先于表头推断 |
| `hasHeader: false` | 不解析表头，全部行作为数据 |
| `includeHiddenRows` / `includeHiddenColumns` | 是否把隐藏行列也纳入结果 |
| `skipEmptyRows` | 是否跳过空数据行（默认 `true`） |
| `trimHeaders` | 是否裁剪表头文本（默认 `true`） |
| `keySeparator` | 路径拼接为 `key` 的分隔符（默认 `" / "`） |
| `hiddenRows` / `hiddenColumns` | 覆盖工作表中的隐藏行列 |
| `formulaCache` | 覆盖工作表中的公式缓存 |

## 导出

- `buildTableStructure` / `importWorksheet` / `parseWorksheet` / `buildTable`
- `WorksheetTableImporter` / `createWorksheetImporter`
- `tableToRecords` / `findColumn` / `readCell`
- `normalizeWorksheet` / `normalizeRange` / `rangeFromA1`
- `MergedRangeOverlapError`

运行检查：

```bash
npm run typecheck
npm test
```
