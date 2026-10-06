# config-edit

编辑简单 `key = value` 配置文件的 TypeScript 库，保证未修改的字节逐一保留。

## 格式约定（按行解析）

- 空行：仅含空格/制表符
- 注释行：可选前导空白后以 `#` 开头
- 条目行：`key = value`，可带行尾注释 ` # comment`

## 关联规则

- 条目正上方、无空行间隔的连续注释行是它的**前置注释**，重排键时随键一起移动
- 值所在行的**尾注释**不归键所有（不会被当作后一个键的前置注释）
- 不属于任何条目的注释（被空行隔开、或位于文件末尾）在重排时保持原位

## 编辑规则

- `set` 只替换值的字节跨度（`valueSpan`），其余字节原样保留
- `moveBefore` / `moveAfter` 将键连同其前置注释整体移动
- 键重复出现时，一切针对该键的编辑（get/set/move）都会被拒绝并抛错
- 每次修改后都会重新解析文本，校验所有值与注释符合预期；不一致则回滚并抛错

## 用法

```ts
import { ConfigEditor } from "./src/config";

const ed = new ConfigEditor("# about a\na = 1 # tail\nb = 2\n");
ed.set("a", "42");          // 仅替换值跨度，尾注释保留
ed.moveBefore("b", "a");    // 移动 b（连同其前置注释，若有）
console.log(ed.toString());
ed.validate();              // 重解析校验值与注释
```

解析结果（`ConfigEditor.parse(text)` / `ed.document`）包含每个条目的
`keySpan`、`valueSpan`、`lineSpan`、`leadingComments`、`trailingComment`，
以及全文件的 `comments` 与 `duplicateKeys`。

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行全部测试
```
