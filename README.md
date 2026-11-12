# 无环多表接入的双向约减

多源数据接入引擎准备执行集合语义自然连接，希望在产生组合前删去不可能参与结果的行。实现TypeScript嵌入式约减与枚举模块：输入有限关系，每个属性名有全局一致的类型，值只含规范十进制整数或UTF8字符串，不含NULL；相同完整行先去重。调用方给一棵以关系为节点的无向树，须验证树连通无环，且每个属性出现的节点诱导连通子树，即running intersection；不满足不能假装运行通用优化器。关系名唯一且非空，取UTF8字节序最小名为根，孩子按同序处理，第一遍后序叶到根、第二遍前序根到叶，对每条有向边用邻表在共享属性上的投影做半连接约减，共享属性为空时邻表非空保留全部、为空删除全部。输出每个原始去重行的存活标志及不存活行首次被删时的有向边与缺失投影键，不能拿最终已变更邻表替代当时依据。基于约减后的树提供可暂停并恢复的连接结果迭代器，按关系名及各关系规范行序组成的选择向量字典序枚举，每个完整结果恰一次，不先构造笛卡尔积；快照令牌只能用于同一不可变输入与树，令牌包含规范内容SHA256校验与完整输入/树指纹，校验不符或换输入须拒绝；这里校验用于检测损坏，不要求对持有源码的恶意调用方提供防伪认证，暂停点不跳行不重行。规范行序按属性名排序逐值比较，整数按数学值、字符串按UTF8字节。调用方可限制最终产出条数，触限返回可继续的暂停而非宣称结果完整。用小规模全笛卡尔积参考核对约减后每一行恰能扩展为完整连接，并测试空关系、空共享键、同属性跨路径、重复行和每个暂停点恢复。这里不实现SQL文本或外部数据库。

## 实现

纯 TypeScript 嵌入式模块，无运行时第三方依赖，不涉及 SQL 文本或外部数据库。

- `src/types.ts`：输入、计划、约减报告、迭代批次的公共类型。
- `src/canonical.ts`：UTF-8 字节序比较、数学值整数比较、规范行序、去重键、规范内容 SHA256 指纹与 base64url 令牌编码。
- `src/plan.ts`：值与模式校验、关系名唯一性、连通无环验证、running intersection 验证、UTF8 字节序根选择与确定的前后序遍历。
- `src/reduction.ts`：完整行去重后执行后序（叶到根）与前序（根到叶）两遍有向半连接；每条边在删除前快照当时邻表投影，报告每个去重行的存活标志、首次删除边与缺失投影键。
- `src/iterator.ts`：基于约减树的深度优先枚举，按关系名字典序与各关系规范行序输出选择向量；不构造笛卡尔积，支持条数上限、可校验快照令牌的暂停/恢复，换输入或校验和损坏均拒绝。
- `test/`：`node:test` 测试，含独立全笛卡尔积参考实现，覆盖空关系、空共享键、同属性跨路径、重复行、非法树/RIP、令牌损坏与逐暂停点恢复。

整数域值用 `bigint` 表示，字符串域值用 `string` 表示，同一属性名全局只允许一个域；NULL 不被接受。

```ts
import { createJoinIterator, reduceJoin, resumeJoinIterator } from './index.ts';

const reduction = reduceJoin(input);
for (const report of Object.values(reduction.reports)) {
  for (const row of report.rowReports) {
    // row.alive / row.firstDeletedBy / row.missingKey
  }
}

const { iterator } = createJoinIterator(input);
const first = iterator.next(100);
if (!first.done && first.token) {
  const next = resumeJoinIterator(input, first.token, 100);
}
```

## 命令

- `npm run typecheck`：严格模式类型检查。
- `npm test`：编译到 `$TMPDIR` 后运行全部 `node:test` 用例（当前 Node 构建不支持直接剥离 TS 类型）。
