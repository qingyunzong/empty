# audit-ledger

防篡改凭证账本：哈希链 + 依赖图，支持动态拓扑（补录插入）、差分余额维护、
失效传播与确定性重算。仅 Node.js 22 标准库，单机离线。

## 模型

- **哈希链**：每张凭证有不可变负载哈希 `H(id, lamport, postings, snapshot, reverses)`；
  链节 `link[i] = H(link[i-1], voucherHash[i])`，根哈希 = `H(merkleRoot, chainTip, balancesHash, invalidated, reversed)`。
- **依赖图**：凭证依赖前置凭证（链序）、科目余额（科目重叠传递闭包）与汇率快照（按 id）。
- **Lamport 时钟**：未指定时 `lamport = max(已见) + 1`；并列时间戳按凭证 id 字典序决胜，
  因此补录用已占用的 lamport + 合适 id 即可插入历史中间。
- **更正仅追加**：错账只能 `reverse` 追加反向凭证并标记失效区间（科目依赖的下游传递闭包），
  旧凭证哈希永不改变；失效状态参与根哈希，可审计。
- **未决 ≠ 不可满足**：快照未到的凭证进入 pending，快照到达时自动落账并触发级联；
  输入结束仍未解决才报 `MISSING_SNAPSHOT`（退出码 3）。
- **证书**：`certify` 原子写入（tmp + rename）含校验和的完整状态；`verify` 从凭证负载
  确定性重算并比对根哈希。截断 → `CERT_INCOMPLETE`，篡改 → `CERT_CORRUPT`，
  重算不符 → `CERT_MISMATCH`，存储哈希不符 → `CHAIN_BROKEN`。

## 运行测试

```sh
node --test
```

## CLI

```sh
# 处理 JSONL 操作流（stdin 或文件），每步输出 {step, root, invalidated, proof}
node cli.js < examples/ops.jsonl
node cli.js examples/ops.jsonl

# 独立校验证书
node cli.js --verify examples/cert.json
```

操作：`config` / `snapshot` / `voucher` / `reverse` / `certify` / `verify` / `finalize`。
错误输出到 stderr（`{"error": CODE, "message": ...}`），退出码 3；成功为 0。

## 验收测试映射（test/）

- `cascade.test.js` — 中间插入引发级联失效；更正中旧账哈希不变
- `chain.test.js` — 断链定位与恢复；序列化状态篡改报 `CHAIN_BROKEN`
- `bruteforce.test.js` — 120 种到达顺序暴力枚举，根哈希/余额全部收敛；差分 ≟ 全量重算
- `cert.test.js` — 证书写入中途崩溃后重启校验、恢复；`MISSING_SNAPSHOT` 退出码 3
- `lamport.test.js` — 并列时间戳字典序决胜；pending 不视为不可满足
