# 测试结果（真实运行记录）

- 环境：Node.js v22.22.1，仅标准库，离线单机
- 命令：`node --test`
- 运行时间：2026-10-04（Asia/Shanghai）
- 总结果：**2 个测试文件，15 个用例，全部通过，0 失败**

## 验收用例（test/acceptance.test.js）

| 用例 | 结果 |
| --- | --- |
| A：召回策略覆盖同严重度普通放行（recall-priority） | ok |
| B：撤销检验后旧证书保留并置 stale，重算幂等（up-to-date，cert.jsonl 字节不变） | ok |
| C：伪造证书被验出（改结论 → exit 10 signature mismatch；连 certHash 一起伪造 → exit 10 conclusion mismatch） | ok |
| D：n=10 缺陷池全组合枚举（3 个风险等级批次 × 2^10 = 3072 组）与独立参考实现逐一比对 | ok |

## 核心机制用例（test/core.test.js）

| 用例 | 结果 |
| --- | --- |
| 批次继承产品族风险等级 | ok |
| 缺陷严重度覆盖继承值 | ok |
| 同严重度放行/扣留冲突按更晚生效策略裁决 | ok |
| 召回策略永远优先（即使放行策略更晚生效） | ok |
| 放行证书携带 counterexample（添加 severity 3 缺陷可翻转为 recall） | ok |
| 输入不变时 certify 幂等（不重复签发） | ok |
| 缺检验记录 → exit 11 | ok |
| 撤销不存在的检验 → exit 11 | ok |
| 策略版本空洞（versions [1,3]）→ exit 12 | ok |
| 输入被篡改后 verify 哈希不匹配 → exit 10 | ok |
| canonical 序列化与键序无关 | ok |

## 原始摘要输出

```
ok 1 - test/acceptance.test.js
ok 2 - test/core.test.js
# tests 2
# pass 2
# fail 0
```

逐用例 TAP 输出：`ok 1..4`（acceptance）、`ok 1..11`（core），无 `not ok`。
