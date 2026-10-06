# indexed-store

事务型内存行存储：字段→行ID 的二级索引、合并差量发布、批内唯一键交换、
提交后可重入订阅、复制表与全量索引模型核验。TypeScript 实现，无运行时依赖。

## 运行测试

```sh
npm test   # tsc 编译到 dist/ 后用 node:test 执行
```

## 设计要点

- **索引模型** `src/store.ts`：每个索引是 `字段值 -> 行ID`（唯一）或
  `字段值 -> Set<行ID>`（非唯一）的映射；`findBy(name, key)` 走索引查询。
- **事务与差量**：事务在暂存区（`pending`）累积每行的最终状态，同一行多次
  修改在提交时合并为单条最终差量；插入又删除、无实际变更均不发布。
- **唯一索引**：约束在提交前对“批末合并视图”校验，因此同一事务内两行可以
  互换键；任何冲突或回调异常都会整体回滚（基表与索引在提交前零改动）。
- **订阅**：回调在提交完全应用之后触发，看到的是已提交状态；回调内可
  重入地开启新事务，嵌套提交会嵌套通知。
- **复制与核验** `src/replicate.ts`：`replicate(source, target)` 先全量
  同步再按差量转发（保留行ID）；`verifyIndexModel` 从行数据重建全部索引
  并与实时索引比对；`verifyReplica` 比对源表与复制表的行集合及双方重建的
  索引模型。

## 示例

```ts
import { Table } from './src/store.js';
import { replicate, verifyReplica } from './src/replicate.js';

const users = new Table('users', [
  { name: 'byEmail', field: 'email', unique: true },
  { name: 'byCity', field: 'city' },
]);

users.subscribe((delta) => console.log('committed delta:', delta));

let a = 0, b = 0;
users.transaction((tx) => {
  a = tx.insert({ email: 'a@x.dev', city: 'Rome' });
  b = tx.insert({ email: 'b@x.dev', city: 'Milan' });
});

// 批内交换唯一键：合法
users.transaction((tx) => {
  tx.update(a, { email: 'b@x.dev' });
  tx.update(b, { email: 'a@x.dev' });
});

const copy = new Table('users-copy', [
  { name: 'byEmail', field: 'email', unique: true },
  { name: 'byCity', field: 'city' },
]);
replicate(users, copy);
console.assert(verifyReplica(users, copy).ok);
```
