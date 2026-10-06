# intsample

面向有限整数参数的约束采样库（TypeScript，零运行时依赖）。

## 功能

- **有限整数参数**：每个变量声明闭区间 `[min, max]`。
- **输入约束**：谓词约束，声明所依赖的变量；引用缺失变量的约束在
  `defineProblem` 时即被拒绝（抛 `ProblemError`）。
- **精确枚举**：`enumerateSolutions` 按字典序回溯枚举全部解，支持
  `maxNodes` / `maxSolutions` 预算。
- **定种子随机**：`sampleRandom` 用 seeded PRNG 打乱域做随机回溯，
  同一种子产生完全相同的样本序列，且样本互不重复。
- **状态三分**：`complete`（请求完成）/ `unsatisfiable`（已证无解）/
  `incomplete`（预算耗尽，未完成的搜索，不做任何断言）——无解与预算
  未完成严格区分。
- **缩减**：`shrinkAssignment` 把合法赋值向各变量域内最接近 0 的方向
  缩减，每个中间候选都经约束校验，结果保证仍满足全部约束。

## 使用

```ts
import { defineProblem, enumerateSolutions, sampleRandom, shrinkAssignment } from 'intsample';

const problem = defineProblem({
  vars: [
    { name: 'x', min: 0, max: 3 },
    { name: 'y', min: 0, max: 3 },
  ],
  constraints: [
    { name: 'sum', vars: ['x', 'y'], check: ({ x, y }) => x! + y! <= 3 },
  ],
});

enumerateSolutions(problem);                    // { status: 'complete', samples: 全部 10 个解 }
enumerateSolutions(problem, { maxNodes: 5 });   // { status: 'incomplete', ... } 预算耗尽
sampleRandom(problem, { seed: 42, count: 5 });  // 确定性随机 5 个不同解
shrinkAssignment(problem, { x: 3, y: 0 });      // 缩减且保持约束
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行
```

测试包含短域穷举交叉验证：对随机生成的小问题，先精确枚举出全部合法解
集合，再断言随机采样与缩减的结果永不落在该集合之外。
