# 风控额度并发判定库 (freeze / hold / release)

仅依赖 Node.js 22 标准库与 `node:test`,单机离线运行。

## 模型

操作以 ndjson 追加到 `history.ndjson`,每行一个 op:

```json
{"opId":"f1","account":"A","type":"freeze","amount":100,"day":"2026-10-02","ts":1,"causes":[]}
```

- `freeze` 占用账户额度;受**账户日冻结上限**(`dailyFreezeCap`)约束,超限进入
  rejected(code 13)且不得部分生效;受账户总额度(`limit`)约束,会导致可用额度为负时
  rejected(code 11)。
- `hold` 依赖一笔未释放完的 freeze(`ref`),把额度从 `remaining` 移入 `held`(仍占额度);
  无足够未释放冻结时 rejected(code 14)。
- `release` 可部分释放(`ref` 指向 freeze,先扣 `held` 再扣 `remaining`);释放多于冻结
  rejected(code 10)。
- `causes` 声明 happens-before 因果边。同一账户的并发分支按 happens-before 合并:
  Kahn 拓扑排序,就绪集内按 `(ts, opId)` 稳定决胜,得到唯一 canonical 合并序列,
  其模拟结果即最优判定(先到先服务优先级)。
- **并列最优**:与 canonical 判定向量完全一致的所有线性化(无法排序的同额操作的各种
  相对次序)全部列出,按 opId 序列字典序稳定排序输出(`tiedOptimal.sequences`)。
  默认上限 `--max-ties 1000`,超出时 `truncated: true`。
- 重复 opId:首次出现参与判定,后续出现 rejected(code 12);`append` 直接拒绝写入。

## 判定码

| code | 含义 |
|---|---|
| 0 | accepted |
| 10 | 释放多于冻结 |
| 11 | 负可用额度 |
| 12 | 重复 opId |
| 13 | 超账户日冻结上限(不得部分生效) |
| 14 | hold 无足够未释放 freeze |
| 15 | 非法 op(金额/缺 ref/未知类型) |
| 16 | 因果环 |

judge 输出中 `null` 表示无限制(`Infinity` 的 JSON 序列化)。

## repair(事后更正,不改史)

`repair` 对历史中每个错误已提交 op(code != 0)追加一条补偿记录
(`type:"compensate"`,确定性 opId `cmp:<opId>` / `cmp:dup:<opId>`),历史只增不改。
补偿 op 不影响额度计算,因此注入 repair 后重放旧 history 判定结果不变。
已存在的补偿会被跳过:崩溃在写补偿前/中,恢复后重跑 repair,每条补偿恰好写入一次。

## 用法

```bash
node cli.js append --history h.ndjson --account A --type freeze --amount 100 \
  [--ref OPID] [--day YYYY-MM-DD] [--ts N] [--causes a,b] [--opId ID]
node cli.js judge  --history h.ndjson [--config cfg.json] [--account A] [--max-ties N]
node cli.js repair --history h.ndjson [--config cfg.json] [--crash-after N]
node cli.js show   --history h.ndjson
```

`cfg.json`: `{"default": {"limit": 1000, "dailyFreezeCap": 500}, "accounts": {"A": {...}}}`

## 测试

```bash
node --test test/*.test.js
```

- `test/judge.test.js` 语义与错误码 10/11/12/13/14/15/16
- `test/ties.test.js` 并列最优全部列出 + 稳定排序;n≤8 与暴力枚举全部线性化对照
- `test/concurrency.test.js` 5 账户 × 200 操作随机并发历史的不变量与确定性
- `test/repair.test.js` 不改史、重放不变、崩溃恢复补偿恰好一次
- `test/cli.test.js` CLI 端到端
