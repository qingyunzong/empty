# layered-settlement

分层结算分块与索引恢复库及 CLI。仅使用 Node.js 22 标准库，测试使用 `node:test`。

## 模型

结算分四层：**预约(reserve) / 冻结(freeze) / 实付(pay) / 撤销(revert)**。
每层是追加日志 `data.log` 中的一个块，保存相对上一层的增量，块头包含：
层级、父层哈希（sha256）、事务集合哈希、自身偏移，块尾为 CRC32。
检查点块保存完整状态快照；`index.json` 记录 head、每层 `{offset, hash}` 与检查点列表。

资金语义（每账户三个资金池）：

- 预约只占用预算 `budget`
- 冻结扣减可用额度 `credit`
- 实付扣减余额 `balance`
- 撤销实付必须先恢复对应冻结链路（金额回到冻结态，不直接释放额度）；
  撤销冻结要求其未被实付消费；只能回退到最近检查点之后的层级

## 提交与恢复

- 提交协议：先写块（fsync）→ 校验整层事务 → 更新索引完成链接。
  层内事务部分失败则整层不提交；已写入但未链接的块成为**孤儿**，
  恢复时列出但绝不并入状态。半截块（torn write）不产生半层。
- `restore --checkpoint N` 利用最近检查点块和后续增量解码，不重放全文件；
  检查点之前的数据层损坏不影响恢复。
- 索引指向的偏移处层号或哈希不符，按索引损坏处理。

## CLI

```sh
node src/cli.js init       --data DIR [--account name:budget:credit:balance]...
node src/cli.js reserve    --data DIR --tx ID --account NAME --amount N [--parent TX]
node src/cli.js freeze     --data DIR --tx ID --account NAME --amount N [--parent TX]
node src/cli.js pay        --data DIR --tx ID --account NAME --amount N [--parent TX]
node src/cli.js revert     --data DIR --tx ID --target TX
node src/cli.js checkpoint --data DIR
node src/cli.js restore    --data DIR [--checkpoint LAYER] [--target LAYER]
node src/cli.js verify     --data DIR
```

退出码：`0` 成功，`1` 业务错误，`2` 数据/索引损坏。

## 测试

```sh
node --test
```

- `test/layers.test.js`：逐层全量计算（≤10 层）与检查点增量恢复比对
- `test/crash.test.js`：部分层写入后崩溃，无半层、孤儿可报告
- `test/corruption.test.js`：中间层 CRC 损坏后恢复旧检查点、跳至损坏层失败、索引损坏
- `test/business.test.js`：撤销链与检查点回退限制
- `test/cli.test.js`：CLI 退出码 0/1/2
