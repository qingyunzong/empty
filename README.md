# 离线更正历史合并库

多个分析端各自离线更正同一观测序列，合并时以**父子闭包**判定并发与因果（不依赖时钟），
冲突以显式事件表达，无需人工介入。仅使用 Node.js 22 标准库。

## 存储布局（历史目录）

- `events.log` — 追加式分块记录，每块含 `id / type / parents / author / counter / payload(base64) / crc32`
- `index.json` — 拓扑索引（确定性拓扑序、深度、作者计数器），纯派生数据
- `heads.json` — 当前叶子 head 集合，纯派生数据
- `HEAD` — checkout 指针

索引或 heads 与事件图矛盾时，以事件图为准重建并向 stderr 报告 `{"level":"warn","code":"REBUILT"}`。

## 规则

- 事件 id = sha256(父集合排序, 作者, 作者计数器, payload)：相同内容、不同 id 的事件**不**自动合并
- `merge(a,b)`：父集合排序后生成确定性合并事件，与输入顺序无关且幂等；一方已含另一方时直接返回后代
- 并发判定：`a≠b 且 互不祖先`（纯图闭包）
- 撤销仅允许删除叶子 head，删除后保留 `tombstone` 墓碑块
- 错误以 JSON 写 stderr：`ERR_CYCLE / ERR_MISSING_PARENT / ERR_CONFLICT / ERR_HEAD`（另有 `ERR_CORRUPT` 用于 CRC 校验失败）

## CLI

```sh
node cli.js init
node cli.js append --author A --payload P [--parents id1,id2]
node cli.js merge h1 h2
node cli.js heads
node cli.js is-ancestor a b
node cli.js checkout head
node cli.js remove head
node cli.js events
# 全局选项：--dir <历史目录>（默认 $HISTORY_DIR 或 ./history）
```

## 库

```js
const { History } = require('./lib/history.js');
const h = History.init(dir);        // 或 History.open(dir)
h.append({ author, payload, parents? });
h.merge(a, b); h.heads(); h.isAncestor(a, b); h.checkout(head); h.remove(head);
```

## 测试

```sh
node --test
```
