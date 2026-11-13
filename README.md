# Shadow DOM 稳定定位

RPA 引擎使用的可导入 TypeScript 元素定位库。查询会沿 composed tree 穿越：

- open shadow root（`mode: "open"`）
- `<slot>` 的 `assignedNodes({ flatten: true })` 分配，以及无分配时的 fallback
- 同源 iframe 的 `contentDocument`，可继续嵌套 shadow/iframe

每一步边界都会记录所在 `Document` 的世代令牌。句柄解析和点击前会重新校验
整条边界链；目标 detach、iframe 导航、shadow root/slot 替换或世代失效时，
从原始查询根重新定位并生成新句柄，绝不会继续点击旧节点。

## 快速使用

```ts
import {
  bumpDocumentGeneration,
  createLocator,
  type ElementHandle,
} from "./index.js";

const locator = createLocator({ requireVisible: true });

const result = locator.locate(document, {
  selector: "button",
  role: "button",
  name: "提交", // accessible name：aria-label / aria-labelledby / label / 文本
});

if (result.status === "ambiguous") {
  // 最高分并列：禁止自动点击
  console.warn(result.ties.map((candidate) => candidate.fingerprint));
} else if (result.status === "unique") {
  const handle: ElementHandle = result.handle!;
  const clicked = locator.click(handle); // resolved + actionability checked
  console.log(clicked.clicked, clicked.reason);
}
```

iframe 导航、文档替换或应用明确使文档世代失效时：

```ts
bumpDocumentGeneration(frameDocument, "iframe-navigation");
```

之后的旧句柄不会被信任，`resolve`/`click` 会在当前文档中重新查找：

```ts
const resolution = locator.resolve(oldHandle);
// current | refreshed | relocated | ambiguous | not-found | stale

if (resolution.status === "relocated") {
  // resolution.element 是新节点，resolution.handle.revision 已递增
  locator.click(resolution.handle!);
}
```

## 结果与安全规则

- `locate()` 返回 `status: "unique" | "ambiguous" | "not-found"`。只有
  `unique` 才带 `element` 和 `handle`；模糊匹配时 `element` 恒为 `null`。
- 候选按语义属性分 + 可见几何分排序。语义分覆盖 role、accessible name、
  `aria-label`、文本、title/alt/placeholder、type、稳定 `data-*` 等；几何分
  覆盖面积、视口交集比例、是否在视口内、距视口中心的距离。
- 所有分数均为整数。最高分出现两个及以上候选时即判定并列，`click()` 即使
  设置 `force: true` 也拒绝点击。
- `click()` 还会拒绝隐藏、`disabled`、`pointer-events: none`、detach 后无法
  唯一定位等目标。
- `handle` 记录 root、规范化查询、边界步骤、各文档世代、分数和指纹。
  `resolve()` 总是先调用 `isHandleCurrent()`；失效后返回的是新句柄对象。

## 主要 API

- `createLocator(options?)` / `new Locator(options?)`
- `locate(root, query, options?)`
- `locateInDocument(document, query, options?)`
- `resolveElement(handle)` / `isHandleCurrent(handle)`
- `safeClick(handleOrResult, options?)` / `clickElement(handle, options?)`
- `scoreElement(element, query)`
- `getDocumentGeneration(document)` / `bumpDocumentGeneration(document)`

`root` 支持 `Document`、open `ShadowRoot` / `DocumentFragment` 和 `Element`。
默认过滤隐藏元素；可用 `requireVisible: false` 或查询级 `visibleOnly: false`
纳入不可见候选。跨源 iframe 无法访问，会被安全跳过。closed shadow root 不会
被遍历。

## 测试

```bash
npm test
npm run typecheck
```

测试使用轻量 DOM 替身覆盖 shadow/slot/iframe、世代失效、iframe 导航、语义/
几何重排、并列拒点、detach 重定位和旧句柄隔离。
