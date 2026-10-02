# lineage-recompute

科研数据平台按谱系（lineage）重算派生数据集的调度库与 CLI。Node.js 22，仅用标准库与 `node:test`，零依赖。

## 模型

- 节点：`{ id, deps, cpu, mem, bytes, cost, owner, recomputable, fails, status }`
- 单机资源：`cpus` / `mem`，并发运行节点的 cpu/mem 之和不得超过机器容量
- 所有者配额：每 owner 的完成字节数上限；跨 owner 公平 = 完成字节数最小优先，
  老化（aging）按等待时长提升优先级防止饿死
- 配额账本 `ledger`：节点完成时按 `bytes` 记账一次；抢占/失效后的重算不再重复计费

## 核心语义

- **联合调度**：DAG 依赖（deps 全部 done 才 ready）+ 单机 cpu/mem 装箱 + owner 配额
  共同决定可运行集；n<=12 时用精确枚举求最大可完成集（依赖闭包 + 配额可行），
  更大规模退化为在线贪心准入。
- **失效传播**：`correct`/`invalidate` 精确失效受影响子树（自身 + 全部传递依赖者），
  未受影响节点的物化证据保留；被失效节点回到 `pending`，未决依赖不会被当作不可满足。
- **抢占**：只杀 `recomputable` 的运行中节点（否则报错），已物化（done）节点永远保留。
- **commit 代际**：每次 commit 落盘 `gen-<n>.json`（tmp+fsync+rename 原子写），HEAD 最后更新；
  崩溃恢复要么看到旧代际、要么看到新代际，绝不撕裂。`undo` 按代际回滚，
  谱系哈希（state root，不含代际计数器）与对应代际快照一致。
- **错误（exit 7）**：环依赖 `CYCLE`、资源超单机 `RESOURCE_EXCEEDED`、
  重复提交 `DUPLICATE` / `DUPLICATE_COMMIT`。

## CLI

```sh
node bin/lineage.js init --cpus 4 --mem 16 --quota alice=25,bob=40 --state .lineage
node bin/lineage.js submit raw --cpu 2 --mem 4 --bytes 10 --cost 3 --owner alice
node bin/lineage.js submit clean --cpu 2 --mem 4 --bytes 8 --cost 2 --owner alice --deps raw
node bin/lineage.js schedule [--preempt id1,id2] [--aging 2]   # 输出调度事件与 stateRoot
node bin/lineage.js correct clean --bytes 9                    # 输出精确失效集
node bin/lineage.js invalidate raw
node bin/lineage.js preempt <id>
node bin/lineage.js commit                                     # 输出代际与状态根
node bin/lineage.js undo
node bin/lineage.js status
```

所有命令输出 JSON，包含调度（schedule）、失效集（invalidated）、状态根（stateRoot）。

## 库

```js
const { Engine } = require('./src');
const engine = Engine.init(dir, { cpus: 4, mem: 16, quotas: { alice: 25 } });
engine.submit('raw', { cpu: 2, mem: 4, bytes: 10, cost: 3, owner: 'alice' });
engine.schedule({ preempt: ['raw'], agingRate: 1 });
engine.correct('raw', { bytes: 12 });
engine.commit();
engine.undo();
```

## 测试（真实结果）

`node --test test/*.test.js`：5 个文件、11 个用例全部通过（Node v22.22.1）。

- `test/scheduler.test.js` — 验收 1：60 个随机 n<=10 DAG，调度完成数与暴力枚举最大可完成集一致；
  事件回放校验资源上限与拓扑序；公平性/老化；失败重试。
- `test/invalidate.test.js` — 验收 2：更正父节点只失效必要后代，未受影响证据保留，
  未决依赖可重算而非不可满足。
- `test/preempt.test.js` — 验收 3：抢占后重算不重复消耗配额（ledger 每节点只记一次）；
  不可重算节点拒绝抢占，物化证据保留。
- `test/commit.test.js` — 验收 4：在 commit 的 6 个写盘步骤分别注入崩溃，
  恢复后要么全见（gen-2）要么不见（gen-1）；undo 按代际回滚且谱系哈希一致。
- `test/cli.test.js` — CLI 端到端（调度/失效集/状态根输出）与 exit 7 错误路径。

注：本沙箱中 node 子进程写管道会丢 stdout，CLI 测试改用临时文件捕获输出。
