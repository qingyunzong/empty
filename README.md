渲染宿主需要TypeScript场景图组件，节点含局部二维仿射矩阵，可引用共享几何但父节点只能一个。批量改父级、变换或几何后原子提交，维护每节点世界变换与子树轴对齐包围盒，仅重算受影响祖先和后代；成环则整批拒绝。调用方可查询固定版本，几何引用计数随版本释放而回收。以全树重算为参照测试剪切、负缩放、多处共享几何和祖孙同时换父，暴露重算计数验证局部修改不遍历无关支路。

## 模块结构

- `src/math.ts`：二维仿射矩阵 `Mat2D`（6 数行主序 `[a,b,c,d,e,f]`）、
  点变换、矩阵累乘、仿射 AABB。包围盒通过四角点变换后取 min/max 得到，
  因此剪切、旋转、负缩放均正确（负缩放会翻转 min/max）。
- `src/geometry.ts`：`Geometry` 共享几何接口与 `GeometryRegistry`。
  引用计数分 `liveRefs`（活节点）与 `versionRefs`（固定版本快照）两部分，
  两者之和归零即回收。
- `src/scene-graph.ts`：`SceneGraph` 与 `Transaction`。
  事务收集换父 / 局部变换 / 几何替换 / 增删节点，`commit()` 原子提交；
  提交前在暂定父级映射上做环检测，成环整批拒绝、无任何副作用。
- `src/version.ts`：不可变固定版本快照 `SceneSnapshot` / `NodeSnapshot`。

## 增量重算策略

- 世界变换：只把变更节点（或移动子树的根、新增节点）标记为脏根，
  自脏根向下 DFS，脏根之外的支路完全不遍历；多脏根用 visited 去重。
- 子树 AABB：收集受影响节点的新旧祖先链，按深度降序自底向上重算；
  干净子树直接复用缓存的 `subtreeBounds`，不向下遍历。
- 纯几何替换不重算任何世界变换（`worldRecomputed === 0`）。
- `getLastRecomputeStats()` 暴露 `worldRecomputed`、`aabbRecomputed`、
  `touchedNodeIds`；`recomputeFullTree()` 提供全树重算参照基线。

## 版本与几何生命周期

- 每次提交（含空提交）生成递增版本号的不可变快照，后续提交不影响旧版本。
- 提交时按版本内引用次数累加 `versionRefs`；`releaseVersion(v)` 归还引用，
  与 live 引用合计归零的几何立即回收，再次获取将抛错。

## 用法

```ts
import { SceneGraph, IDENTITY } from './dist/index.js';

const graph = new SceneGraph();
graph.geometries.register({ id: 'g', localBounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });

const v1 = graph
  .beginTransaction()
  .addNode('root', null, IDENTITY)
  .addNode('child', 'root', [2, 0, 0, 2, 10, 0], 'g')
  .commit();

graph.beginTransaction().setTransform('child', [3, 0, 0, 3, 0, 0]).commit();
const stats = graph.getLastRecomputeStats(); // 仅 child 子树参与重算

graph.getVersion(v1.version).getNode('child'); // 旧版本内容不变
graph.releaseVersion(v1.version);               // 归还版本引用，可能触发几何回收
```

## 构建与测试

- `npm run build`：类型检查并输出到 `dist/`。
- `npm test`：构建后运行 `node:test` 全部用例（共 27 个），
  覆盖剪切、负缩放、多处共享几何、祖孙同批换父、成环整批拒绝、
  固定版本 / 引用计数回收，以及增量重算与全树重算的计数对比。
