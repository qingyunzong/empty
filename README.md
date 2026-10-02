# defect-responsibility

质量追溯：缺陷区域在多台设备（轴对齐有理矩形）之间的责任分摊，全部使用精确分数运算（BigInt）。

## 模块

- `src/fraction.js` — 精确有理数（`p/q` 字符串、十进制、整数均可解析，自动约分）。
- `src/geometry.js` — 左闭右开矩形 `[x1,x2)×[y1,y2)`：交集、面积、平移、缩放、重叠证书（含 x/y 切分区间）。
- `src/workspace.js` — 设备/缺陷模型；每次修改为事务（产生空矩形或非法坐标即回滚，undo 栈不变）；提交后支持 undo/redo；责任比例并列最大时输出全部并列设备。
- `src/cli.js` — 从 stdin 读 JSON，输出每个缺陷块的总面积、各设备重叠面积/比例、责任设备集合与重叠证书。

## CLI 输入格式

```json
{
  "devices": [{"id": "A", "rects": [[0, 0, 2, 2]]}],
  "defects": [{"id": "d", "rect": [1, 0, 3, 2]}],
  "ops": [
    {"op": "move",  "defect": "d", "dx": "1/2", "dy": 0},
    {"op": "scale", "defect": "d", "factor": "3/4", "anchor": "center"},
    {"op": "split", "defect": "d", "axis": "x", "at": 2, "newId": "d2"},
    {"op": "undo"},
    {"op": "redo"}
  ]
}
```

坐标可写整数、小数或 `"p/q"` 字符串。运行：`node src/cli.js < input.json`

## 测试

`node --test`（node:test）。验收对照：n≤8 矩形用全部坐标构成的网格逐格枚举面积，与库计算结果比对。
