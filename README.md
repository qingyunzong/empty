# contenteditable 快照范围编辑

一个无副作用、可导入的 TypeScript 范围编辑包。它保留 contenteditable
快照的容器与节点身份，只把逻辑串指定范围替换为新的文本节点，不会把整个
控件替换成纯文本。

## 导入

```ts
import {
  replaceRange,
  getLogicalText,
  type Snapshot,
  type Anchor,
} from "./index.ts";
```

## 数据模型

```ts
type RichNode = ContainerNode | TextNode | BreakNode | AtomicNode;

interface ContainerNode {
  type: "container";
  id: string;
  children: readonly RichNode[];
}

interface TextNode {
  type: "text";
  id: string;
  value: string;
}

interface BreakNode {
  type: "br";
  id: string;
}

interface AtomicNode {
  type: "atom" | "atomic";
  id: string;
}
```

`atom` 与 `atomic` 是同一原子节点类型的兼容字面量。

快照为 `{ version, root }`，根节点必须是容器。所有节点 ID 必须非空且唯一；
树不能有环，每个节点只能有一个父节点。文本值必须是合法 Unicode。

逻辑串按文档顺序生成：

- 文本节点贡献其 UTF-16 单元。
- `br` 贡献一个 `"\n"`。
- 原子节点贡献一个 `"\uFFFC"`。
- 容器不贡献字符，只负责嵌套。

## API

```ts
const result = replaceRange(
  snapshot,
  {
    start: { nodeId: "text-1", offset: 2 },
    end: { nodeId: "text-3", offset: 1 },
    text: "新值",
  },
  {
    expectedVersion: snapshot.version,
    generateId: () => nextId(),
  },
);
```

- 文本锚点的 `offset` 是该文本节点内的 UTF-16 偏移。
- 容器锚点的 `offset` 是原始 `children` 数组中的子节点间隙。
- `br` 和原子节点不能直接作为锚点，只能由父容器间隙定位。
- 锚点会先折算为逻辑串位置；起点必须不晚于终点。
- 锚点落在代理对中间时返回 `SPLIT_SURROGATE`。
- 非空范围只要包含原子字符 `U+FFFC`，整次编辑返回 `ATOM_IN_RANGE`，
  原子节点及其两侧内容保持不变。范围起止于原子字符边界是允许的。

编辑规则：

- 删除范围按原始快照解释，插入不会改变删除边界。
- 删除文本与 `br`；所有容器均保留，空容器也保留。
- 未删除的文本节点保留原 ID。起点文本若被切分，左半保留原 ID，右半使用
  新 ID；终点文本的剩余右半保留原 ID。
- 新文本即使为空也总是生成一个新文本节点，并插入起始锚点。
- 文本内部插入会把原节点拆成“左半 / 新文本 / 右半”；左半为空时仍保留
  原节点和原 ID。
- 容器间隙插入使用原始子列表的间隙位置，即使该间隙附近的文本已被删除，
  新节点仍属于该容器。
- 空文本节点除起点文本节点和新插入文本节点外均删除。

返回结果：

```ts
interface ReplaceResult {
  snapshot: Snapshot;          // 新快照，version 沿用输入值
  tree: ContainerNode;         // 等同于 snapshot.root
  cursor: Anchor;              // 折叠在新文本节点末尾
  normalizedRange: {
    start: number;             // 原始逻辑串位置
    end: number;
  };
  mapping: readonly (number | null)[];
  retainedCharacters: readonly {
    newOffset: number;
    oldOffset: number;
  }[];
}
```

`mapping` 以新逻辑串的 UTF-16 偏移为下标。保留下来的字符（包括保留下来的
`br`、原子字符）映射到原逻辑串位置；新插入字符为 `null`。
`retainedCharacters` 是 `mapping` 中非空项的文档顺序列表。

## 失败原子性

版本不符、非法锚点、切分代理对、无序范围、跨原子字符、非法替换文本、
非法 ID 或 ID 冲突都会抛出 `RangeEditError`。调用方应读取 `error.code`。
所有校验和 ID 分配都在构建新树之前完成，任何失败都不会修改旧快照。

错误码：

`INVALID_SNAPSHOT`、`INVALID_REQUEST`、`VERSION_MISMATCH`、
`INVALID_ANCHOR`、`SPLIT_SURROGATE`、`UNORDERED_RANGE`、
`ATOM_IN_RANGE`、`INVALID_TEXT`、`INVALID_ID`、`ID_COLLISION`、
`ID_GENERATION_FAILED`。

## 测试

```sh
npm test
```

测试会把 TypeScript 源码和测试编译到 `TMPDIR` 下的隔离目录，随后运行
Node 测试并清理构建目录。测试覆盖嵌套容器、空范围、代理对、仅删除 `br`、
原子边界、空节点/空容器、节点身份、游标、位置映射、失败原子性，并用逻辑
串切片公式穷举核对多组范围。
