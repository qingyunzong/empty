# JSON:API included 资源闭包

JSON:API 同步服务使用的零依赖 TypeScript 资源合并库。它会解析 primary data、included、
relationship linkage 和局部字段集，按 `type`/`id` 合并同一资源的多个稀疏表示，并输出从
primary data 可达的资源闭包及缺失 linkage。

## 使用

```ts
import { mergeJsonApiDocuments } from "./index.ts";

const result = mergeJsonApiDocuments({
  data: {
    type: "articles",
    id: "1",
    attributes: { title: "JSON:API" },
    relationships: {
      author: { data: { type: "people", id: "9" } },
      comments: {},
    },
  },
  included: [
    { type: "people", id: "9", attributes: { name: "Ada" } },
    { type: "people", id: "9", attributes: { email: "ada@example.com" } },
  ],
});

result.resources; // 可达资源，按 primary data/included 的首次出现顺序排列
result.resources.get("people", "9");
result.all;       // 所有已合并资源，包括不可达的 included 资源
result.roots;     // primary data 对应的资源
result.missing;   // 指向不存在资源的 linkage，元素带 type/id
```

## 合并规则

- 同一 `type`/`id` 的每个表示只贡献自己实际出现的字段；缺失字段不会覆盖已有值。
- 相同字段的值深度相等时继续合并；值不同会收集冲突并抛出
  `JsonApiMergeConflictError`，整轮不会返回部分结果。
- `attributes` 按属性名合并。`relationships` 的 `data` 是完整 linkage；重复关系必须一致。
- 关系对象没有 `data` 时表示 linkage unknown，不会被当成 `null` 或 `[]`。
  `data: null` 和 `data: []` 分别表示已知的空 to-one / to-many 关系。
- 未知关系不会参与闭包遍历，也不会计入 `missing`。
- `included` 中从 primary data 不可达的资源不会出现在 `resources`/`closure` 中，
  但仍可通过 `all` 查看。
- 同一 linkage 目标缺失时，`missing` 只记录一次；可通过非枚举的 `source`、
  `relationship`、`path` 属性定位首个引用。

## 其他入口

- `mergeJsonApiDocument`、`mergeDocuments`、`mergeJsonApi`：文档入口别名。
- `mergeResources(primary, included?)`：直接合并资源表示。
- `buildResourceClosure(input)`、`resolveJsonApi(input)`：闭包/解析入口别名。
- `tryMergeJsonApiDocuments(input)`：返回 `{ ok, result }` 或 `{ ok: false, error }`。
- `parseJsonApiDocument(input)`：接受对象或 JSON 字符串并做基础结构校验。
- `getResourceKey({ type, id })`：返回稳定的 `type:id` 展示键。

`data` 可以是单个资源、资源数组或 `null`。也可以传入文档数组，或把多个文档作为多个参数。
设置 `roots` 可覆盖闭包起点；设置 `rootMode: "all"` 可把全部资源作为起点。
`rejectConflicts: false` 会保留首个值并在 `result.conflicts` 中报告冲突；默认严格拒绝。
`linkageMerge: "union"` 可对两个已知 to-many linkage 做并集合并。

运行测试：`npm test`；类型检查：`npm run typecheck`。
