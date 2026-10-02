# agv-scheduler

仓库 AGV 调度器的离线重演工具:单进程模拟多 AGV 成员关系、租约(lease)+
fencing 代次的任务认领、因果序冲突判定、原子持久化与崩溃恢复。
Node.js 22,仅标准库,`node:test` 测试,单机离线,零依赖。

## 使用

```sh
node bin/agv.js replay  events.jsonl        # 重演事件日志,输出 JSONL 决策与终态
node bin/agv.js lease   --store D --task t1 --agv a1 --epoch 2 [--lease-ms 1000] [--now MS] [--crash-at P]
node bin/agv.js recover --store D           # 崩溃恢复
node bin/agv.js audit   events.jsonl [--store D]
npm test                                    # node --test 全量
```

输入输出均为 JSONL(`-` 表示 stdin)。`replay` 输出每个事件的 `decision`
记录、按 id 排序的 `task`/`member` 终态与 `summary`,同一日志多次重演
输出逐字节一致。

## 事件模型

| type         | 字段 | 语义 |
|--------------|------|------|
| `join`       | `agv,time` | 成员上线 |
| `leave`      | `agv,time` | 主动离开:未完成任务立即进入可接管集(`takeoverEligible`) |
| `quarantine` | `agv,time` | 隔离:禁止认领新任务,历史与既有租约保留,租约到期才可被接管 |
| `release`    | `agv,time` | 解除隔离 |
| `task`       | `task,time` | 注册任务(首个 claim 也会自动注册) |
| `claim`      | `task,agv,epoch,time,leaseMs,vc` | 带 fencing 代次与向量时钟的认领 |
| `complete`   | `task,agv,time` | 仅租约有效期内的属主可完成 |

## 因果与并发

事件携带向量时钟 `vc`。对同一任务的并发 claim:

- 可比较(存在 happened-before):先者持有;后者在租约未到期时被拒(`held`),
  到期后以更高代次 `takeover`;乱序到达的早先事件记 `superseded`。
- 不可比较(并发):任务**保持 pending**(`contested=true`)而非失败,
  清空属主;直到出现一个因果上晚于所有竞争者的 claim 才重新授予。

三车并发抢单的终态因此是确定的:任务 pending、无属主、contested。

## 租约与 fencing

- 每个任务维护单调递增的 `fencingEpoch`;非属主认领要求 `epoch > fencingEpoch`,
  属主续约要求 `epoch >= fencingEpoch`。低代次 claim 被拒绝,CLI `lease` 以
  **exit 8** 返回。
- 接管仅在旧租约到期(`now > leaseExpiry`)或属主 `leave` 后发生;隔离不删
  历史、不提前释放租约。

## 持久化与崩溃恢复

提交协议:写 `lease.tmp` → fsync → **原子 rename 为 `lease.json`** → fsync 目录。
rename 是唯一提交点。三个故障注入点(`--crash-at`,进程以 exit 75 模拟崩溃):

| 注入点 | 恢复结果 |
|--------|----------|
| `after-tmp-write`(rename 前) | 租约未授予;`recover` 丢弃 `lease.tmp`,回到旧状态 |
| `after-rename`(rename 后) | 租约已授予;`lease.json` 即新状态 |
| `after-commit`(目录 fsync 后) | 完全持久,同 `after-rename` |

任何时刻只有一个 `lease.json`,rename 原子性保证不会出现双重占有。
`lease.json` 带 SHA-256 校验和;JSON 损坏、校验和不匹配、版本/shape 非法、
fencing 代次回退等持久化校验失败一律 **exit 9**。

## 退出码

| code | 含义 |
|------|------|
| 0 | 成功 / 审计通过 |
| 1 | claim 被拒(held)或审计发现违例 |
| 2 | 用法错误 |
| 8 | 低代次 claim(stale epoch) |
| 9 | 持久化校验失败 |
| 75 | 模拟崩溃(`--crash-at`) |

## 审计

`audit` 重演日志并对每条授予/续约/接管决策做独立影子校验:
无双重占有(租约有效期内唯一属主)、fencing 代次单调、仅活跃成员可持有、
接管发生在租约到期后;`--store` 时再交叉比对持久态与重演终态。
违例以 JSONL `violation` 记录输出,退出码 1。

## 布局

```
bin/agv.js        CLI 入口
src/cli.js        子命令:replay / lease / recover / audit
src/scheduler.js  重演引擎:成员、租约、fencing、因果判定
src/vclock.js     向量时钟比较/合并
src/store.js      原子提交存储、校验、崩溃恢复
src/audit.js      不变式影子校验
test/             node --test 全量(含 <=6 任务全调度序枚举,共 1274 例)
```
