# 离线更正历史合并库

多个分析端各自离线更正同一观测序列，合并时基于事件图判定并发、因果与冲突。Node.js 22，仅标准库。

## 存储

历史目录（默认 `./.history`，可用 `--dir` 或 `HIST_DIR` 指定）含：

- `events.log`：分块事件记录，每块为 `EV1 <字节数> <crc32>` 头 + 一行 JSON。事件含 `id`（内容寻址 SHA-256）、`parents`、`payload`、`author`、`counter`（作者计数器）、`crc`；撤销产生 `kind:"tombstone"` 墓碑块。
- `index.json`：确定性拓扑索引（Kahn + id 字典序决胜）。
- `heads.json`：当前 heads。

索引或 heads 与事件图矛盾时，以事件图重建为准，重写两个文件并经 stderr 报告 `{"warning":"HEADS_REBUILT",...}`。

## 语义

- 并发/因果只由父子闭包判定：`isAncestor(a,b)` 为 b 沿父指针可达 a，不涉及时钟。
- 相同 payload、不同 id 的事件不自动合并。
- `merge(a,b)`：父集合排序后内容寻址，输入顺序无关、幂等；一方是另一方祖先时直接返回后代。
- `undo` 仅允许叶子 head，写入墓碑块而非物理删除。
- 错误一律 stderr JSON：`ERR_CYCLE` / `ERR_MISSING_PARENT` / `ERR_CONFLICT` / `ERR_HEAD`，退出码 1。

## CLI

```
node cli.js [--dir D] init
node cli.js [--dir D] append --author A --payload '<json>' [--parents id1,id2]
node cli.js [--dir D] merge h1 h2
node cli.js [--dir D] heads
node cli.js [--dir D] is-ancestor a b
node cli.js [--dir D] checkout head
node cli.js [--dir D] undo head
```

## 库

`lib/history.js` 导出 `init / append / merge / heads / isAncestor / checkout / undo / loadStore`，错误为带 `code` 的 `HistError`。

## 测试

```
node --test
```

真实运行输出见 `RESULTS.md`。
