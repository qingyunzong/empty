# gen-module-loader

一个 TypeScript 模块加载库：静态链接导入导出、按依赖深度初始化、活绑定、
TDZ 报错、循环不重复执行、失败传播、代际重置，并附带事件轨迹与显式状态机核验。

## 运行测试

```sh
npm test   # tsc 编译 + node --test 执行 dist/test/*.test.js
```

## 核心概念

- **状态机**（`ModuleState` / `LEGAL_TRANSITIONS`，见 `src/loader.ts`）：
  `Unlinked -> Linking -> Linked -> Evaluating -> Evaluated`，
  `Linking`/`Evaluating` 可转入 `Failed`。所有迁移经过校验，非法迁移抛
  `InvalidTransitionError`。
- **静态链接**：`link()` 在任何模块体执行前解析全部导入导出；未知模块或
  缺失导出抛 `LinkError`，并使模块进入 `Failed`。
- **依赖深度初始化**：链接时计算深度（叶子为 0），`evaluate`/`evaluateAll`
  按深度升序、最深叶子优先初始化。
- **活绑定 + TDZ**：导入方每次读取都解析到导出方当前的 `Binding`；读取未
  初始化的绑定抛 `UninitializedBindingError`。
- **循环**：处于 `Evaluating` 的模块被再次到达时直接返回，模块体绝不重复执行。
- **失败传播**：依赖失败时，依赖方不执行模块体，直接以
  `DependencyFailedError` 进入 `Failed`。
- **代际重置**：`reset()` 递增代际并为所有模块重建 `Unlinked` 记录；旧代际
  的失败记录保持原状。
- **事件轨迹**：`trace()` 返回全部事件（define/transition/evaluate/reset），
  每条带代际号；`verifyTrace(trace)` 依据迁移表回放轨迹，返回违规列表。

## API 摘要

```ts
const reg = new Registry();
reg.define({ name, imports, exports, body });   // 定义模块
reg.link(name?);                                 // 静态链接（单个或全部）
reg.evaluate(name); reg.evaluateAll();           // 按深度初始化
reg.load(name); reg.loadAll();                   // link + evaluate
reg.namespace(name);                             // 活绑定命名空间（getter）
reg.reset();                                     // 新代际
reg.trace(); verifyTrace(reg.trace());           // 轨迹与状态机核验
```
