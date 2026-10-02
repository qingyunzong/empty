# 结算轨迹合规库与 CLI

仅 Node.js 22 标准库。用 NFA 描述允许流程，对带时间戳的观察日志（角色：经办 / 复核 / 清算 / 归档）做合规判定、增量重判与合规证书验证。

## 用法

```bash
node cli.js judge flow.json log.jsonl                  # 判定，输出 verdict/prefix/continuations/proof
node cli.js judge flow.json log.jsonl --verify proof.json  # 同时独立验证证书
node --test                                            # 运行全部测试
```

退出码：0=接受，1=拒绝，2=输入/校验错误，3=证书验证失败。

## 输入格式

`flow.json`：`{states, alphabet, start, accept, transitions:[[from, role, to], ...]}`（也接受 `{from, role, to}` 对象形式；不支持 ε 转移，见 `examples/flow.json`）。

`log.jsonl`：每行一个事件 `{"id":"e1","ts":1000,"role":"经办"}`，时间戳须单调不减，id 唯一；上限 1000 条事件、200 个 DFA 状态。

## 库 API（lib.js）

- `compileFlow(flowJson)` → `{dfa, hash, shortestPath}`：子集构造 + 最小化 + 规范化哈希
- `judgeEvents(compiled, events)` → `{verdict, prefix, continuations, finalState, path?}`
- `new Session(flow)`：`append / retract / replace` 后 `judge()` 增量重判，返回 `cache.hitRate`
- `makeProof` / `verifyProof(flow, log, proof)`：合规证书生成与独立验证

错误码：`NFA_EPSILON_ONLY`、`TIME_REORDER`、`ID_REUSE`、`CACHE_POISON`（另有规模限制 `LOG_LIMIT` / `STATE_LIMIT`）。
