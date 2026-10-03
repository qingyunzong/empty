# lineage-platform

科研数据平台派生数据集按谱系重算。Node.js 22，仅用标准库与 `node:test`。

## 模型

- 节点：`{id, owner, cpu, mem, deps, bytes, duration, materialized, retries}`
- 单机资源：`cpu`/`mem` 限制并发；节点需求超单机即报错（exit 7）
- 配额：按 owner 的完成字节数上限；完成时才扣减，失效时退回
- 公平：就绪队列按「owner 完成字节数 − 老化率 × 等待时长」排序，防饿死
- 配额受限且未决节点 ≤12 时，枚举最优可完成集做准入规划；更大规模回退贪心

## CLI

```
node src/cli.js <cmd> [args] [--state dir]
init '{"cpu":8,"mem":32,"quotas":{"alice":100}}'
submit '{"id":"raw","owner":"alice","bytes":5,"deps":[]}'
correct raw '{"bytes":12}'     # 更正并精确失效子树
invalidate raw                 # 输出失效集
preempt                        # 只杀可重算节点，保留已物化证据
schedule                       # 输出调度事件与完成集
commit                         # 代际快照，原子提交（journal + rename）
undo                           # 按 commit 代际回滚，谱系哈希一致
status                         # 输出状态根（sha256）
```

领域错误（环依赖、资源超单机、重复提交等）输出错误码并以 exit 7 退出。

## 崩溃恢复

commit 先写 `journal.json` 并 fsync，再原子 rename 为 `current.json`。
恢复时若发现残留 journal，说明崩溃发生在 rename 之前，直接丢弃：
恢复结果要么完整看到旧代际，要么完整看到新代际。

## 测试

```
node --test test/*.test.js
```
