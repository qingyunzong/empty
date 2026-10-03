# quota-freeze-replica

额度冻结副本库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 每个副本维护账户总额/已冻金额、成员配置纪元（epoch）、事件日志与观察前沿（frontier）。
- 冻结/释放事件携带 `requestId`、`account`、`amount`、`memberId`、`epoch`、`prevHash`，
  事件 ID 为内容的 SHA-256；成员变更（add-member/remove-member）同样是因果事件。
- 校验规则：
  - 成员非活跃（含已移除）→ `stale-member`
  - 冻结超额 → `limit-exceeded`
  - 事件纪元与当前配置纪元不符 → `stale-epoch`
  - 前置哈希断链 → `missing-prev`
  - 移除成员时附带的观察前沿未包含该成员最新事件哈希 → `remove-incomplete`
- 移除前已确认的冻结继续有效；移除后旧成员的新事件被拒绝。
- 反熵：`diff` 比较两份状态摘要，输出缺失的冻结/释放/成员事件 ID；`merge` 按因果序应用缺失事件。

## CLI

```sh
node src/cli.js init         --state s.json '{"account":"acct","total":100,"memberId":"m1"}'
node src/cli.js add-member   --state s.json '{"member":"m2","by":"m1"}'
node src/cli.js freeze       --state s.json '{"requestId":"r1","account":"acct","amount":40,"memberId":"m2"}'
node src/cli.js release      --state s.json '{"requestId":"r1","memberId":"m2"}'
node src/cli.js remove-member --state s.json '{"member":"m2","by":"m1","frontier":{"m2":"<hash>"}}'
node src/cli.js diff         --state s.json peer.json
node src/cli.js merge        --state s.json peer.json
node src/cli.js account      --state s.json
```

- 输入输出均为 JSON；出错时输出 `{"error":"code"}` 且退出码为 1。
- `remove-member` 省略 `frontier` 时自动使用本地观察前沿；提供的 `frontier` 未覆盖
  被移除成员最新事件哈希时返回 `remove-incomplete`。

## 测试

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```
