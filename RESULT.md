# RESULT — 真实测试运行记录

- 运行时间 (UTC): 2026-10-03 05:09
- 运行时: Node.js v22.22.1（仅标准库，无第三方依赖）
- 命令: `node --test`

## 汇总（node --test 实际输出）

```
ok 1 - test/a-recall-override.test.js
ok 2 - test/b-revoke-idempotent.test.js
ok 3 - test/c-forgery.test.js
ok 4 - test/d-enumeration.test.js
ok 5 - test/errors.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 9141.674556
```

## 逐条用例（18/18 通过）

```
== test/a-recall-override.test.js
ok 1 - A: recall policy always overrides a later release policy at same severity
ok 2 - A: later release beats earlier hold at same severity when no recall exists
ok 3 - A: defect severity overrides inherited family risk
ok 4 - A: end-to-end via CLI writes recall certificate for inherited high-risk lot
== test/b-revoke-idempotent.test.js
ok 1 - B: revoking a test flips old cert to needs-recompute, old cert retained
ok 2 - B: recompute after revocation is idempotent (byte-identical cert.jsonl)
ok 3 - B: repeated evaluate with no changes is idempotent from the start
== test/c-forgery.test.js
ok 1 - C: genuine certificate verifies successfully
ok 2 - C: forged conclusion is detected (exit 10)
ok 3 - C: forged selfHash is detected (exit 10)
ok 4 - C: tampered inputs no longer match certified input hash (exit 10)
ok 5 - C: deleted certificate is detected (exit 10)
== test/d-enumeration.test.js
ok 1 - D: exhaustive enumeration of defect combinations for n<=10 matches oracle
ok 2 - D: counterexample field appears exactly when a small perturbation flips a release
== test/errors.test.js
ok 1 - exit 11: lot without any inspection records
ok 2 - exit 11: revoke references an unknown test
ok 3 - exit 12: policy version gap
ok 4 - exit 12: verify also rejects gapped policy versions
```

## 验收项对照

- A 召回覆盖普通放行: v1 recall@sev3 与 v2 release@sev3 冲突时输出 recall（recall 永远优先）。
- B 撤销检验后重算幂等: 撤销后旧证书状态 valid→needs-recompute 且保留，追加新证书；再次 evaluate 后 cert.jsonl 字节级不变（appended=0）。
- C 伪造证书被验出: 篡改结论/selfHash/输入/删除证书，verify 均 exit 10。
- D n<=10 缺陷组合枚举对照: 对 inherited∈{1,2,3}、n=0..10、严重度∈{1,2,3} 全枚举（265,752 组），`decide` 与独立暴力 oracle 逐一比对一致；counterexample 字段存在性与暴力扰动搜索逐一比对一致。

## 退出码

- 10 哈希不匹配（HASH_MISMATCH）
- 11 缺检验（MISSING_TEST）
- 12 策略版本空洞（POLICY_VERSION_GAP）

## 环境备注

本沙箱禁止 spawn 子进程（EPERM），因此 CLI 以 `require('../cli.js').run(argv, io)` 进程内方式被测试驱动；`node cli.js ...` 直接执行的端到端冒烟（evaluate/verify/revoke 流程）亦已手工验证通过。
