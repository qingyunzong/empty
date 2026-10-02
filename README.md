# defect-allocation

质量追溯：缺陷区域责任分摊库与 CLI。单机离线、Node.js 22、零依赖，全部面积为精确分数（BigInt 有理数）。

## 模型

- 加工台面由若干轴对齐有理矩形组成，每个矩形归属一个设备 id。
- 缺陷区为轴对齐有理矩形，支持增量 `moveDefect` / `scaleDefect` / `splitDefect`。
- 矩形为左闭右开 `[x1, x2) x [y1, y2)`：共边重叠面积为 0；完全包含时重叠面积等于缺陷面积。
- 报告给出每个设备对每个缺陷块的重叠面积、总面积（所有设备重叠面积之和）、责任比例（面积 / 总面积）。
- 责任比例并列最大时，`responsible` 输出全部并列设备。
- 每次修改是一个事务：产生空矩形或非法坐标（非有限数、零/负缩放、边界或外部切分等）即回滚，撤销栈不变；已提交事务支持 `undo()` / `redo()`。
- 每个正面积重叠输出证书：`xInterval` / `yInterval` 切分区间与面积。

## 坐标格式

整数、`"p/q"` 分数串、十进制串（精确转换）、或 `{ "num": p, "den": q }`。

## 库用法

```js
import { AllocationEngine } from './src/allocation.js';
const engine = new AllocationEngine();
engine.addDevice('devA', { x1: 0, y1: 0, x2: 1, y2: 1 });
engine.addDefect('d1', { x1: 0, y1: 0, x2: 2, y2: 1 });
engine.splitDefect('d1', 'x', '3/2');
engine.report(); // { blocks: [...] }，分数以 "p/q" 字符串序列化
```

## CLI

从 stdin 读 JSON（命令数组或 `{ "commands": [...] }`），向 stdout 写 `{ results, report }`：

```sh
echo '{"commands":[{"op":"addDevice","id":"a","rect":{"x1":0,"y1":0,"x2":2,"y2":2}}]}' | node cli.js
```

命令：`addDevice` / `removeDevice` / `addDefect` / `removeDefect` / `moveDefect`（`dx`,`dy`）/ `scaleDefect`（`sx`,`sy`，绕矩形最小角缩放）/ `splitDefect`（`axis`,`at`,`blockIndex`）/ `undo` / `redo` / `report`。

## 测试

```sh
node --test
```

含验收对照：n<=8 矩形时用所有坐标形成的网格逐格枚举面积与库结果对照（100 组随机用例）、共边零面积、对半并列、非法缩放回滚且撤销栈不变。
