# ftgateway — 文件传输网关分片重组库

Python 3.11 标准库实现，无任何第三方依赖。处理互相重叠、乱序、重复的
分片，坏分片绝不污染已验证数据。

## 结构

- `ftgateway/fragments.py` — 分片模型（传输 id、epoch、偏移、内容、总长度、
  总哈希、内容哈希）
- `ftgateway/intervals.py` — 区间树：覆盖、缺口、来源证据（provenance）
- `ftgateway/reassembler.py` — 按 `(transfer_id, epoch)` 管理的重组器
- `ftgateway/gateway.py` — 网关：epoch 管理、虚拟超时回收、检查点、
  提交日志、原子发布
- `ftgateway/cli.py` — JSON Lines CLI
- `tests/` — unittest 套件（含穷举枚举与独立逐字节模型核对）

## 语义

- **重叠**：内容相同的重叠被接受并合并覆盖；内容不同的重叠抛出
  `ConflictError`，携带**最小冲突区间**与**双方分片 id**，整条输入被拒绝，
  已验证状态不受污染。
- **总长度**：只能由未知转为确定一次；试图改变长度抛 `LengthChangeError`，
  须 `Gateway.start_new_epoch()` 开新 epoch。旧 epoch 的分片被丢弃。
- **稀疏临时文件**：缓冲字节超过 `memory_threshold` 后溢写到 spool 目录的
  临时文件，之后按偏移 pwrite。
- **撤回**：`withdraw(fragment_id)` 移除分片并从剩余分片重建覆盖，可能
  产生新缺口。
- **动态 MTU**：`retransmit_plan(mtu)` 把缺口按当前 MTU 切块，供重发请求。
- **超时与提交互斥**：`tick(now)` 回收超时传输，但正在提交（`committing`
  临界区 + 网关提交锁）的完整文件绝不回收——提交胜出。
- **恢复**：检查点（原子写）记录分片证据；提交日志记录提交意图。恢复时
  逐分片重哈希校验证据，临时文件被篡改的传输被隔离，**绝不发布缺洞或被
  篡改的文件**。完成文件经总哈希核验后以 `os.replace` 原子替换发布。
  恢复幂等，可重复执行。

## CLI

```sh
python3.11 -m ftgateway.cli --workdir W --publish-dir P \
    [--memory-threshold N] [--timeout SECS] [--recover]
```

stdin 每行一个 JSON 命令，stdout 每行一个 JSON 回复：

```json
{"cmd":"add","transfer_id":"t","epoch":0,"fragment_id":"f1","offset":0,
 "data_b64":"aGVsbG8=","total_length":5,"total_hash":"<sha256hex>"}
{"cmd":"withdraw","transfer_id":"t","epoch":0,"fragment_id":"f1"}
{"cmd":"gaps","transfer_id":"t","epoch":0}
{"cmd":"retransmit","transfer_id":"t","epoch":0,"mtu":1024}
{"cmd":"new_epoch","transfer_id":"t"}
{"cmd":"tick","now":123.4}
{"cmd":"commit","transfer_id":"t","epoch":0}
{"cmd":"status"}
```

冲突回复示例：

```json
{"ok":false,"error":"conflict","conflict":{"start":11,"end":12,
 "existing_fragment_id":"a","new_fragment_id":"b"}}
```

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：短字节串的全切分 × 全交付排列穷举并与独立逐字节来源模型
（`tests/model.py`）核对；重叠冲突（最小区间与双方分片 id）、零长文件、
尾片先到、超时同刻完成、撤回造成新缺口、重复恢复、临时文件被篡改、
坏分片不污染、epoch 长度变更、动态 MTU 重发计划、CLI 端到端。
