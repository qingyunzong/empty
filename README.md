# cfgdom

从线性字节码构建控制流图（CFG），计算支配关系（dom / idom）、识别回边与循环头，
并输出 JSON 报告。仅依赖 Python 3.11 标准库。

## 输入格式

`prog.json` 是指令数组，每条指令：

| 字段          | 类型       | 默认   | 含义                                   |
|---------------|------------|--------|----------------------------------------|
| `offset`      | int        | 必填   | 指令偏移，必须唯一                     |
| `fallthrough` | bool       | `true` | 是否顺序落到下一条指令                 |
| `targets`     | list[int]  | `[]`   | 跳转目标偏移（必须是指令偏移）         |

`fallthrough: false` 且 `targets: []` 的指令即 HALT/RET，无后继。

## 语义

- **基本块切分**：入口指令、跳转目标、跳转/终止指令的下一条为块入口（leader）。
- **块编号**：按起始偏移升序编号，入口块 `id = 0`；不可达块保留并标记
  `"reachable": false`（其 `dom`/`idom` 为 `null`）。
- **dom 集**：迭代不动点算法（`dom(entry) = {entry}`，其余初始化为可达块全集，
  反复取可达前驱交集直到收敛）。
- **idom**：严格支配者中 dom 集最大者；入口块 `idom = null`。
- **回边**：边 `u -> v` 且 `v` 支配 `u`（含自环）；循环头为回边目标。
- **错误**：坏边（目标不是指令偏移）、重复偏移、空程序抛出 `CFGError`
  （异常携带 `offset`）；CLI 打印错误并以退出码 **8** 退出，不写 `dom.json`。

## CLI

```bash
python -m cfgdom prog.json --emit dom.json   # 写入文件
python -m cfgdom prog.json                   # 输出到 stdout
```

`dom.json` 包含每个块的 `id/start/end/offsets/successors/reachable/dom/idom`，
以及 `edges`、`back_edges`、`loop_headers`。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试覆盖：

- **A**：随机采样 500 个 CFG（块数 n<=6、边数 <=8，固定种子），迭代不动点结果
  与“删除节点后不可达”的暴力路径支配定义逐一比对（dom 与 idom 均一致）。
- **B**：不可达块被保留并标记，且不影响可达块的 idom/dom。
- **C**：if-else 菱形汇合点的 idom 为条件块。
- **D**：自环与跨块回边正确识别，前向边不误判。
- 校验与 CLI：坏边/重复偏移/空程序报 `CFGError`（含 offset），退出码 8 且不写文件。

## 真实运行结果

`python -m unittest discover -s tests -v`（Python 3.14.4，2026-10-01）：

```
Ran 14 tests in 1.093s

OK
```

`python -m cfgdom examples/prog.json --emit examples/dom.json`（含一个自环
`1 -> 1` 与一个不可达块 3）真实输出节选：

```json
"back_edges": [[1, 1]],
"loop_headers": [1]
```

块 3（offset 8）输出为 `"reachable": false, "dom": null, "idom: null"`。

坏输入 `[{"offset": 0, "fallthrough": false, "targets": [42]}]` 的真实行为：

```
CFGError: bad edge: target 42 is not an instruction offset (offset 0)
exit=8   # 且不生成 dom.json
```
