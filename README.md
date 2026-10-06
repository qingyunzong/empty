# modlink

一个模拟 ECMAScript 模块语义的静态链接模块加载库（TypeScript 实现）。

## 特性

- **静态链接导入/导出**：`link()` 在链接期解析全部 `imports` / `reexports`，
  缺失模块、缺失导出、二义性再导出均在链接期报 `LinkError`。
- **按依赖深度初始化**：`evaluate()` 以后序 DFS 保证依赖先于依赖者执行，
  链接期同时计算每个模块的依赖深度（`depthOf`）。
- **未初始化绑定报错**：读取尚未初始化的绑定抛出
  `UninitializedBindingError`（TDZ 语义），错误信息包含绑定名、所属模块与请求方。
- **活绑定**：导入解析到导出方的绑定槽，读取时穿透到最新值。
- **循环不重复执行**：环中的模块每代际只执行一次，正在求值的模块直接返回。
- **失败传播**：求值失败沿依赖链传播给所有依赖者；同代际内失败是终态，
  重复求值直接重抛原错误且不重新执行。
- **重置需新代际**：`reset()` 递增 `generation`，丢弃全部实例（含失败态），
  定义保留并惰性重建；同代际内禁止重复 `define`。
- **事件轨迹 + 明确状态机**：所有状态迁移经过校验（非法迁移抛
  `ModuleStateError`），`trace` 记录 `define` / `state` / `evaluate` / `reset`
  事件，带全局序号与代际号。

## 状态机

```
unlinked -> linking -> linked -> evaluating -> evaluated
              |           |           |
              +-> failed  +-> failed  +-> failed   (failed 为代际内终态)
```

`linked -> failed`：依赖失败时，尚未执行的依赖者直接失败，不进入求值。

## 用法

```ts
import { ModuleLoader } from "modlink";

const loader = new ModuleLoader();

loader.define("counter", {
  exports: ["count", "increment"],
  evaluate: (ctx) => {
    ctx.set("count", 0);
    ctx.set("increment", () => ctx.set("count", (ctx.get("count") as number) + 1));
  },
});

loader.define("app", {
  imports: [{ from: "counter", names: ["count", "increment"] }],
  exports: ["snapshot"],
  evaluate: (ctx) => {
    (ctx.get("increment") as () => void)();
    ctx.set("snapshot", ctx.get("count")); // 活绑定：读到最新值 1
  },
});

loader.evaluate("app");            // 自动先链接，再按依赖深度初始化
loader.read("app", "snapshot");    // 1
loader.stateOf("app");             // "evaluated"
loader.stateHistoryOf("app");      // ["unlinked->linking", "linking->linked", ...]
loader.reset();                    // 新代际，可重新求值
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行全部测试
```
