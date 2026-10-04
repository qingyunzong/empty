# crdt-text-copy

文本复制库（RGA 风格 CRDT），TypeScript 编写，仅使用 Node.js 内置模块，零运行时依赖。

## 设计

- **唯一 ID + 前驱 ID**：每个字符携带全局唯一 ID（`站点@序号`，序号零填充保证字典序可排）和前驱字符 ID，构成一棵树（根为 `ROOT`）。
- **并发同位置插入按 ID 排序**：同一前驱下的兄弟节点按 ID 降序排列，所有副本确定性地收敛到同一顺序。
- **删除留墓碑**：删除只置 `deleted` 标志，节点保留在树中，后续插入仍可以它为前驱。
- **前驱未到先缓冲，不能改挂根**：前驱未知的插入进入缓冲区等待，**绝不**挂到 `ROOT`；前驱到达后递归冲刷。删除目标未到时同样缓冲。
- **恶意依赖环检测**：缓冲区内沿前驱链检测环（互相依赖 `A↔B`、自环 `A→A`），环上节点整体拒绝并记入黑名单，重放仍拒绝；依赖环节点的消息永久缓冲、不进投影。
- **乱序/重复消息**：重复消息幂等（`duplicate`）；乱序消息经缓冲后收敛。测试以「全事件按因果序构树」的投影为基准，对照「乱序 + 1~3 份重复」的多副本投影。

## 使用

```ts
import { CrdtDocument, ROOT, makeId, insert, del } from "./src/crdt";

const doc = new CrdtDocument();
const a = makeId("siteA", 0);
doc.apply(insert(a, ROOT, "h"));        // "applied"
doc.apply(insert(makeId("siteA", 1), a, "i"));
doc.apply(del(a));                      // 墓碑：投影为 "i"，节点保留
doc.projection();                       // => "i"
```

`apply` 返回状态：`applied` / `duplicate` / `buffered` / `rejected-cycle` / `rejected`。

## 测试

```
npm test    # tsc 编译 + node:test 运行
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc 编译为 JS 后运行；本机 Node 构建未启用类型剥离）。

### 实际运行结果（2026-10-05）

```
▶ sequential inserts
  ✔ chained predecessors build the text in order
▶ concurrent inserts at the same position
  ✔ siblings are ordered by id, replicas converge
▶ deletes and tombstones
  ✔ delete hides the char but keeps the node; inserts after it still work
  ✔ delete arriving before its target is buffered, then applied
▶ out-of-order and duplicate delivery
  ✔ child before parent is buffered, never re-attached to root
  ✔ duplicates are idempotent
▶ malicious dependency cycles
  ✔ mutual cycle is detected and rejected, projection untouched
  ✔ self-loop is rejected immediately
  ✔ node depending on a cycle member never enters the projection
▶ shuffled + duplicated stream vs full in-order event log
  ✔ fuzz seed 1: replicas converge to the reference projection
  ✔ fuzz seed 7: replicas converge to the reference projection
  ✔ fuzz seed 42: replicas converge to the reference projection
  ✔ fuzz seed 1337: replicas converge to the reference projection
  ✔ fuzz seed 20261005: replicas converge to the reference projection
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

14/14 通过。模糊测试每个种子生成 300 个事件的因果日志，派生 3 个副本分别乱序并注入重复消息后应用，投影、树大小、墓碑数均与基准一致。

## 文件

- `src/crdt.ts` — CRDT 核心（树结构、缓冲、环检测、投影）
- `tests/crdt.test.ts` — node:test 测试套件
- `types/node.d.ts` — `node:test` / `node:assert` 最小类型声明（无 @types 依赖）
