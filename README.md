# JSON:API included 图归并

数据连接器需要可导入的 TypeScript JSON:API 文档归并库，以 type+id 建立资源图，应用 included、links、relationships 和 sparse fieldsets。重复资源的属性冲突必须按文档来源世代裁决，缺 linkage 不臆造节点；环关系可查询但序列化保持确定顺序，并保存每个字段的来源指针。

## 用法

```ts
import { mergeDocuments } from "./index.js";

const graph = mergeDocuments([docA, docB], { generations: [1, 2] });

graph.get("articles", "1");            // 按 type+id 查节点
graph.related(node, "author");         // 解析 linkage（缺 linkage 返回 []，不臆造节点）
graph.reachable("articles", "1");      // BFS 遍历，环安全、顺序确定
graph.fieldSource("articles", "1", "title"); // 字段来源指针 { documentIndex, generation, pointer }
graph.toDocument({ fields: { articles: ["title"] } }); // 确定性序列化 + sparse fieldsets
```

- 归并按字段粒度进行：更高 `generation` 的文档赢得冲突；同世代时更晚的文档赢得冲突；同一文档内先出现者保留。
- `data` 与 `included` 中的资源都会进入图；缺少 `type`/`id` 的资源记入 `graph.skipped`。
- 序列化为扁平 JSON:API 文档，节点按 `(type, id)` 排序，字段名按字典序输出，多次调用结果一致。

## 脚本

- `npm test`：编译到 `build/` 并运行 `node --test`
- `npm run typecheck`：`tsc` 严格类型检查
