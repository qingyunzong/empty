# subtitle-track

分层字幕区间编辑库（TypeScript，零依赖）。

## 语义

- 区间为半开区间 `[start, end)`，单位毫秒（非负整数）。
- 交叠遮挡：层（`layer`）高者遮挡低者；同层时后插入者优先。
- `insert` / `crop` / `remove` 每次变更产生新版本并可 `undo`；
  `undo` 精确恢复到变更前的同一版本号与状态。
- `visibleSegments()` 输出最大连续可见段及其来源字幕（`clipId`）。

## API

```ts
const track = new SubtitleTrack();
const id = track.insert(0, 5000, 0);   // [0,5000)ms, layer 0
track.insert(1000, 2000, 1);           // 高层遮挡
track.crop(id, 500, 4500);             // 裁剪为与 [500,4500) 的交集
track.undo();                          // 恢复裁剪前版本
track.visibleSegments();               // [{ start, end, clipId, layer }, ...]
track.visibleAt(1200);                 // 某时刻可见的 clip
```

## 测试

```sh
npm test   # tsc 编译 + node:test
```

测试包含单元用例与随机化属性测试：40 个种子 × 120 步随机
插入/裁剪/删除/撤销，每步与逐毫秒栅格暴力模型对照，并校验撤销
恢复到完全相同的版本与状态。
