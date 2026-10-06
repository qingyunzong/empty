# crdt-counter

基于 PN-Counter 变体的 CRDT 计数库（TypeScript，整数全部使用 `bigint`）。

## 语义

- **每副本每代际一对增减分量**：键为 `副本ID#代际`，分量为 `{ inc, dec }`，只增不减。
- **合并按分量取最大值**：满足交换律、结合律、幂等律，乱序/重复合并安全。
- **撤回 = 追加反向量**：`undoLast()` 把最近一次本地操作的反向量计入当前分量，旧分量永不删除，撤回本身也可合并传播。
- **重启带新代际**：`restart()` 开启新代际分量，旧代际分量保留并继续参与合并；滞后的旧状态重放不会覆盖新数据。
- **当前值**：`value() = Σ(inc) − Σ(dec)`，可为负。

## 用法

```ts
import { Counter } from "./src/counter.js";

const a = new Counter("replica-a");
a.increment(5n);
a.decrement(2n);
a.undoLast();        // 撤回 decrement(2n)
a.restart();         // 进入代际 2
a.increment(10n);

const b = new Counter("replica-b");
b.merge(Counter.fromJSON(JSON.parse(JSON.stringify(a.toJSON()))));
console.log(b.value()); // 15n
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```

测试覆盖：基本增减、负结果、撤回反向量语义、重启代际、合并幂等/交换/结合，
以及随机化对照测试——多副本随机执行增/减/撤回/重启后，以乱序、重复的方式
互相合并（经 JSON 序列化模拟网络），最终所有副本的值必须等于完整操作集合
的代数和，且状态完全收敛。

注：环境需全局可用的 `tsc`（或 `npm install` 安装 devDependency）。
