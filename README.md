# 包配置渲染与深度合并组件

零依赖、可嵌入的 TypeScript 组件，用同一份快照完成：

- `defaults`、包级值、运行时覆盖值三层深度合并；
- 映射逐键深入，数组和标量整值替换；
- 模板包含与命名辅助函数的依赖排序、环检测和源码位置报告；
- 渲染期间热替换覆盖值或重定义辅助函数时，批次内与已完成结果保持隔离；
- 输出字符串与 UTF-8 字节一一对应。

## 快速开始

```ts
import { createRenderEngine } from "./build/index.js";

const engine = createRenderEngine({
  defaults: {
    title: "default",
    user: { name: "reader", role: "viewer" },
    ports: [80],
  },
  packageValues: {
    title: "package",
    user: { role: "admin" },
    ports: [8080],
  },
  overrides: {
    user: { name: "Grace" },
  },
  templates: {
    page: "{{> header}}\n{{upper user.name}} ({{user.role}})",
    header: "== {{title}} ==",
  },
  helpers: {
    upper: (_context, value) => String(value).toUpperCase(),
  },
});

engine.render("page");
// "== package ==\nGRACE (admin)"

engine.renderBytes("page"); // Uint8Array，UTF-8
engine.renderResult("page"); // 文本、字节、版本与冻结后的合并值
```

构建后从包根导入：

```ts
import {
  createRenderEngine,
  RenderEngine,
  deepMerge,
  mergePackageValues,
} from "dlks-formal-10035";
```

## 合并语义

```ts
import { deepMerge, mergePackageValues } from "./build/index.js";

mergePackageValues(defaults, packageValues, overrides);
deepMerge(defaults, packageValues, overrides);
```

- 普通对象与原生 `Map` 按自有键递归合并，后层优先。
- 数组整体替换，不拼接；数组元素会被深拷贝。
- 标量、`null`、数组遇到后层时整体替换。
- 键缺失时保留下层值；键存在但值为 `null` 或 `undefined` 时视为显式覆盖。
- 不读取原型链上的属性，并使用定义属性写入，`__proto__` 不会污染 `Object.prototype`。
- 普通对象、数组及日期、正则、`Map`、`Set`、ArrayBuffer 视图会复制；其他类实例按不透明值保留引用。

```ts
deepMerge(
  { a: { keep: 1, clear: 2 }, list: [1, 2] },
  { a: { clear: null }, list: [3] },
);
// { a: { keep: 1, clear: null }, list: [3] }
```

## 模板语法

| 语法 | 含义 |
| --- | --- |
| `{{user.name}}` | 读取合并值，缺失、`null`、`undefined` 输出空字符串 |
| `{{> header}}` | 包含模板，依赖位置记录在该标签处 |
| `{{upper user.name}}` | 调用命名辅助函数；后续参数可为路径或字面量 |
| `{{helper "x" 42 true null}}` | 双引号/单引号字符串、数字、布尔值和 `null` 字面量 |
| `{{! comment }}` | 注释，不参与输出和依赖图 |
| `{{{value}}}` | 与双花括号相同；组件不做 HTML 转义 |

模板名、值路径和辅助函数名支持字母、数字、`_`、`$`、`.`、`/`、`-`。如果值路径与已注册辅助函数同名，会优先按辅助函数调用。当前不支持块辅助函数。

## 辅助函数与依赖

辅助函数签名为 `(context, ...args) => unknown`。返回对象时按 JSON 文本输出；辅助函数必须同步返回。
参数里的裸名称会先解析为合并值；若要传递路径字符串本身，请使用引号，例如 `{{state "user.name"}}`。

```ts
const engine = createRenderEngine({
  templates: {
    page: "{{decorate title}} {{> footer}}",
    footer: "-- {{owner}}",
  },
  helpers: {
    decorate: {
      // 跨模板/辅助函数依赖可用于静态排序和环检测
      dependencies: ["helper:trim", "template:footer"],
      render: (_context, value) => `[${String(value).trim()}]`,
    },
    trim: (_context, value) => String(value).trim(),
  },
});
```

依赖名的解析规则：

- `template:name` 明确指向模板；
- `helper:name` 明确指向辅助函数；
- 裸名称优先匹配辅助函数，其次匹配模板。

`context` 提供：

- `values`：本次快照的只读合并值；
- `lookup(path)` / `has(path)`：按点路径读取，能区分缺失键与显式 `null`；
- `render(templateName)`：在同一快照内动态渲染模板；
- `invoke(helperName, ...args)`：在同一快照内动态调用辅助函数。

模板包含、模板内辅助函数调用以及声明的辅助函数依赖构成统一有向图。`dependencyOrder()` 返回稳定、依赖优先的顺序。成环时抛出 `DependencyCycleError`，其中 `cycle`、`edges`、`locations` 和错误消息都包含环路径；模板标签产生的边带有 1 起始的行列位置。例如：

```text
Dependency cycle detected: template:a -> template:b -> template:a;
template:a -> template:b (include) at a:2:3;
template:b -> template:a (include) at b:2:1
```

缺失包含模板或声明依赖会抛出 `UnknownDependencyError`，并尽量携带引用位置。语法错误抛出 `TemplateSyntaxError`，辅助函数执行失败抛出带模板位置的 `TemplateRenderError`。

## 快照与热替换

`render()`、`renderBytes()`、`renderBatch()` 和 `renderAll()` 都会在开始时取得不可变快照：

- 一次批次全部使用同一版本的值、模板和辅助函数；
- 辅助函数在渲染中调用 `setOverrides()` 或 `setHelper()`，只影响后续快照；
- 已返回的字符串、`Uint8Array` 和 `RenderResult` 不会被后续更新改写；
- `RenderResult.bytes` 每次创建新数组，修改它不会影响其他结果；
- 渲染异常时不返回半成品文本。

```ts
const first = engine.renderResult("page");

engine.setOverrides({ title: "new" });
engine.setHelper("upper", (_context, value) => `#${value}`);

first.text;                    // 仍为旧快照结果
engine.render("page");         // 使用新覆盖值和新辅助函数

const snapshot = engine.snapshot();
const batch = snapshot.renderAll();
for (const name of snapshot.templateNames()) {
  batch.results.get(name).text === snapshot.render(name);
}
```

热更新 API：

- `setDefaults(value)`、`setPackageValues(value)`、`setOverrides(value)` 整层替换；
- `patchOverrides(value)` 将补丁深度合并到覆盖层；
- `setOverride(path, value)` 设置单个点路径；
- `unsetOverride(path)` 删除覆盖键，使其恢复为“缺失”语义；
- `clearOverrides()` 清空覆盖层；
- `setTemplate(name, source)`、`removeTemplate(name)`、`setHelper(name, helper)`、`removeHelper(name)`。

每次更新原子递增 `engine.version`。

## 验证

```bash
npm run build
npm test
```

测试包含：

- 小规模平坦与嵌套值树的三层穷举，与独立参考合并器逐项对照；
- 穷举值的模板输出与参考 UTF-8 字节对照；
- 模板环、模板/辅助函数环、辅助函数环及行列位置；
- 渲染中覆盖值替换和辅助函数重定义交错时的快照隔离；
- 批次全量渲染与单模板渲染的字节一致性。
