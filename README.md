# agv-scheduler

冷库 AGV 离线调度器：安全策略判定任务能否进入禁区 / 冷链区 / 充电区，断网期间全程可审计。Node.js 22，仅标准库。

## 使用

```sh
node bin/agv-scheduler.js --map map.json --tasks tasks.jsonl --grants grants.jsonl \
  --plan plan.jsonl --deny deny.jsonl
```

退出码：`0` 正常；`22` 时钟缺父事件；`23` 坐标越界；`24` 双人授权同人。

## 数据模型

- `map.json`：`bounds:{width,height}` + `zones[]`，每区含 `kind`（`normal|restricted|coldchain|charging`）、`aisles[]`、`shelves[]`（带 `x,y`）。
- `grants.jsonl`：`{id,kind:"grant",subject,zone|aisle|shelf,from,to,clock,parents}` 与 `{id,kind:"revoke",target,at,clock,parents}`。
- `tasks.jsonl`：`{id,subject,type("normal"|"rescue"),priority,target:{shelf|aisle|zone|x,y},time,completeTime,authorizers?,clock,parents}`。

## 核心机制

- **权限继承**：库区授权覆盖其巷道与货架，巷道授权覆盖其货架（`src/scheduler.js` 的 `covers`/`coversZone`）。
- **救援破例**：`restricted` 区的 deny 可被 `type:"rescue"` 任务破例，需两名不同授权人；破例写入 `exception` 审计记录。同人重复授权 → exit 24。
- **撤销分段**：撤销按生效时间截断授权区间；撤销前已占用巷道的任务保留一次性临时通行证（`tempPass`，绑定任务 id），撤销后的新任务不得沿用。
- **因果判定**：所有事件构成 Lamport 父指针 DAG，"先见授权后派单"要求授权事件在派单事件的因果过去中（与文件顺序无关）；放行记录输出 `causalChain`。父事件缺失 → exit 22。
- **反例生成**：deny 记录的 `counterexamples` 列出"删除哪条撤销则任务合法"的证据（撤销 id、对应授权、恢复区间）。
- **可达区域枚举**：任务数 ≤10 时，每条记录附带 `reachableZones`，供逐区独立重判对照（验收 D）。

## 测试

```sh
node --test
```

结果见 `RESULT.md`。
