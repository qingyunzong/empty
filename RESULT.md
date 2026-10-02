# RESULT — 测试真实结果

- 日期（UTC）：2026-10-02T21:56:39Z
- 环境：Node.js v22.22.1，仅标准库，单机离线
- 命令：`node --test`

## 总览

```
# tests 7        # 测试文件数
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 20171.427421
```

7 个测试文件全部通过，共 37 个用例（逐文件 `node <file>` 统计 `# Subtest` 得出），0 失败。

## 分文件结果

| 测试文件 | 用例数 | 结果 | 覆盖 |
|---|---|---|---|
| `test/unit.test.js` | 12 | 全过 | 双链继承合并、最近具体优先、冲突证书、时间窗边界、revokeAt、回溯撤销、反例生成与复核、环检测、模式校验 |
| `test/errors.test.js` | 8 | 全过 | exit 2（JSON 非法/请求缺字段）、exit 3（未知主体/设备）、exit 4（角色/区域环并列环）、exit 0  happy path |
| `test/acceptance-a.test.js` | 8 | 全过 | 验收 A：继承+冲突混合 50 请求 |
| `test/acceptance-b.test.js` | 4 | 全过 | 验收 B：撤销后重放历史一致 |
| `test/acceptance-c.test.js` | 4 | 全过 | 验收 C：应拒绝却允许的反例可检出 |
| `test/acceptance-d.test.js` | 1 | 全过 | 验收 D：n=1..8 规则真值表对照（9840 个组合） |

## 验收点核对

- **A（继承+冲突混合 50 请求）**：CLI 处理 `fixtures/requests.jsonl`（50 条），
  输出 `evaluated 50 request(s): 21 allow, 29 deny, 8 conflict(s)`，exit 0；
  audit.log 含 8 条 `WARN` 冲突证书、3 条 `NOTICE` 回溯撤销；
  50/50 条决定均带可翻转且已验证的 `counterexample`。
- **B（撤销后重放一致）**：普通撤销仅影响 revokeAt 及之后（h2 翻转、h1 不变）；
  急停回溯撤销使撤销点前的 h3 一并失效；同一历史重放两次输出完全一致。
- **C（反例检出）**：回溯撤销具体 deny 导致的“应拒绝却允许”被三重检出——
  决定记录 `alerts`、audit.log `ALERT` 行、单步反例（`unrevoke_rule guard-deny`
  翻转回 deny，且 `verifyCounterexample`/`verifyDecision` 复核通过）。
- **D（真值表对照）**：n=1..8，每规则取 适用allow/适用deny/不适用 三态，
  共 3+9+…+6561=9840 组合，解释器结果与独立参考语义逐一对照一致。

## 复现

```sh
node --test
node src/cli.js --policies fixtures/policies.json --requests fixtures/requests.jsonl \
     --decisions decisions.jsonl --audit audit.log
```
