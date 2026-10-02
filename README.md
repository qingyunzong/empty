# maint-planner — 设备科离线保养工单规划器

Node.js 22、仅标准库。输入工单（时长/停机窗/备件/技能）、技师（班次/技能）、
备件套件（数量/兼容件），输出字典序最优的全部并列指派，或最小冲突证书。

## 模型

- 时间为离散整数槽。工单 `o` 占用 `[start, start+duration)`，必须落在
  `window = [ws, we)` 内；`we < ws` 直接报 `ERR_WINDOW`。
- 技师：工单必须由具备对应 `skill` 的技师在某个班次区间内**开始**；
  超出班次结束的部分计为加班（`overtime`）。同一技师同一时刻只干一单。
- 套件：工单执行期间占用套件单元，结束后归还（跨工单时间耦合）。
  每个时刻的备件需求必须能二部匹配到 `compatible` 兼容的套件单元。
- 切换（`switches`）：同一技师时间线上相邻工单技能不同的次数。

## 目标与枚举

字典序：`(完成数 max, 加班 min, 切换 min)`。分支限界精确求解，
`optimalCount` / `solutions` 枚举**全部**并列最优指派。

## 锁定 / 增量重解

`solve(instance, { locks: [{order, tech, start}] })`：锁定指派先占用班次与
套件资源，再对其余工单增量重解；不传 `locks` 即恢复全量求解。
锁定本身冲突（技能/窗口/班次/资源）返回 `ERR_LOCK`。

## UNSAT 证书与 UNKNOWN

- 未能完成全部工单时，`plan()` 附加删除极小的冲突工单子集
  （去掉任一单即可行）与资源瓶颈（套件强制并发不足 / 班次容量不足），
  并给出 `certificateHash`（规范 JSON 的 SHA-256）。
- `verifyCertificate(instance, cert)` 可复验：子集不可行、每个去单子集可行、哈希一致。
- 搜索超出 `nodeLimit` 返回 `UNKNOWN` —— 不是不可行的证明，不出证书。

## CLI

```
node src/cli.js [input.json] [--require-all] [--all] [--node-limit N] [--lock order:tech:start ...]
```

从文件或 stdin 读实例，stdout 输出 JSON（`status/objective/optimalCount/
assignments/certificate/certificateHash`）。退出码：`INFEASIBLE`/`ERR_LOCK` → 1，
`ERR_WINDOW`/`ERR_INPUT` → 2，其余 0。

## 测试（真实结果）

`node --test`，9 项全部通过：

```
ok 1 - 9-order instance matches independent branch-and-bound reference
ok 2 - kit quantity off by one yields a re-verifiable minimal conflict
ok 3 - locking one assignment then re-solving stays consistent; unlock restores
ok 4 - conflicting locks are rejected with ERR_LOCK
ok 5 - window end earlier than start raises ERR_WINDOW
ok 6 - node-limit exhaustion reports UNKNOWN, never INFEASIBLE
ok 7 - certificate hash is deterministic over key order
ok 8 - CLI emits JSON with certificate hash for a partial plan
ok 9 - CLI --require-all exits 1 with INFEASIBLE when orders cannot all complete
```

验收对照：9 工单实例（`examples/nine.json`）与测试内独立实现的分支限界
参考求解器目标值与并列最优解集合完全一致（completed=9, overtime=0,
switches=2, 8 个并列最优）；套件差一（`examples/offbyone.json`）产出
可复验最小冲突 `{w1,w2}` + 套件瓶颈 + 哈希。
