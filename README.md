# evidence-store

事务型防篡改证据库（Node.js 22，仅标准库，单机离线）。每个提交批次生成可独立验证的
哈希链证书，任何对数据文件、索引或证书的篡改都能被检测并定位。

## 设计

**存储布局**（`--dir` 指定的数据目录）：

```
data.log          # 追加式记录文件：[u32 长度][JSON 记录] 帧
wal.log           # 预写日志：begin + 本批全部记录 + end
certs/NNNNNN.cert # 每个提交批次的独立证书文件（原子 tmp+rename 写入）
index.json        # 二级索引：byId / bySubmitter / byTime（派生数据，可重建）
```

**哈希链**：每条记录 `hash = SHA256(prevHash ‖ canonical(content))`，其中 content 为
`{seq, batch, id, submitter, timestamp, data}` 的键序规范化 JSON；链跨批次连续，
批次首条记录的 `prevHash` 为上一批次的链头哈希，创世记录的 `prevHash` 为 32 字节零。
**链头哈希（批次最后一条记录的哈希）即提交证书**的核心内容。

**提交流程**（每步都 fsync）：

1. 写 WAL（begin 含 `baseOffset` 与 `prevHash`，随后是全部记录）；
2. 记录追加到 `data.log`；
3. 写证书文件 `certs/<batch>.cert`（含 `headHash`、`prevHeadHash`、`recordCount` 等）；
4. 更新 `index.json`；
5. 截断 WAL，提交完成。

**崩溃恢复**：打开库时若 WAL 非空——证书存在则提交已完成，仅清理 WAL；证书缺失
则说明崩溃发生在写证书之前，按 WAL 中的 `baseOffset` 截断 `data.log` 整体回滚该批次，
之前批次的证书不受影响。恢复时还会从 `data.log` 重建索引并与持久化索引比对，
`verify` 将索引不一致同样报告为 `TAMPER`。

## CLI

```bash
evidence put    --dir D --id ID --submitter NAME --data TEXT [--time ISO]
evidence put    --dir D --batch-file records.json   # 多记录批次（JSON 数组）
evidence get    --dir D --id ID                     # 读取并即时重算哈希验证
evidence list   --dir D [--submitter NAME] [--from ISO] [--to ISO]
evidence verify --dir D                             # 重放全库校验哈希链/证书/索引
evidence cert   --dir D --batch N [--out FILE]      # 导出某提交的证书
```

也可作为库使用：`import { EvidenceStore } from './src/store.js'`。

## 错误约定

| 代码        | 含义                                             | 退出码 |
| ----------- | ------------------------------------------------ | ------ |
| `TAMPER`    | 哈希/链/证书/索引不匹配，消息含首个失配记录偏移  | 1      |
| `NO_CERT`   | 某批次证书文件缺失                               | 1      |
| `NOT_FOUND` | 证据 ID 不存在                                   | 1      |
| `DUP_ID`    | 证据 ID 重复                                     | 1      |
| 退出码 2    | 注入的模拟崩溃（`EVIDENCE_CRASH_BEFORE_CERT=1`） | 2      |

## 测试

```bash
node --test
```

真实运行结果（2026-10-03，Node v22.22.1）：

```
ok 1 - scenario 1: three batches commit, verify passes, certs independently verifiable
ok 2 - scenario 2: one-byte tamper of data.log -> TAMPER with correct offset
ok 3 - scenario 3: crash before cert write -> batch invisible, prior certs valid
ok 4 - secondary index: query by submitter and time range
ok 5 - NO_CERT: deleting a certificate is reported
ok 6 - CLI end-to-end: put/get/list/verify/cert
# tests 6
# pass 6
# fail 0
```

三个验收场景的覆盖方式：

1. **正常写入 3 批次**：`verify` 通过；测试不依赖库代码、直接读取 `data.log`
   原始字节用 `crypto` 重算整条链，逐批与证书文件比对，证明证书可独立验证。
2. **单字节篡改**：外部修改 `data.log` 第 2 条记录数据区一个字节后，
   `verify` 报 `TAMPER` 且 `offset` 精确等于该记录帧起始偏移；
   `get` 该记录同样立即报 `TAMPER`；CLI stderr 输出 `TAMPER ... offset=<N>`。
3. **写证书前崩溃**：以 `EVIDENCE_CRASH_BEFORE_CERT=1` 运行 CLI 触发真实进程
   退出（exit 2，WAL 与 data.log 已落盘、证书未写）；重启后恢复逻辑整体回滚
   该批次（`get` 返回 `NOT_FOUND`，`verify` 通过且只有之前 2 个批次），
   之前批次的证书文件字节不变且仍然有效，后续可继续正常提交。
