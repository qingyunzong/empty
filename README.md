# evc — 证据链版本库

单机离线、仅 Node.js 22 标准库的证据链版本管理工具。

## 模型

- 每个版本记录：父版本哈希、结构化补丁（`patch.upsert` / `patch.delete`）、claim 列表；
  版本哈希 = 规范 JSON 的 SHA-256。
- 证据文件内容以 SHA-256 寻址存入 `.evc/objects/`，版本对象存入 `.evc/versions/`。
- `verify` 从创世版本沿父链增量重放到目标版本：逐个校验证据 blob 存在且哈希一致、
  claim 不引用已删除证据；通过后生成由内容哈希与父哈希组成的证书
  （`.evc/certificate.json`，含 `certificateHash = sha256(contentHash + ':' + parentHash)`）。
- `checkout` 仅从补丁链重建目标版本完整清单（不依赖工作区当前状态），先校验后落盘；
  目标版本损坏时原检出目录保持不变，退出码 2。

## 用法

```sh
node evc.js init                  # 初始化仓库（.evc/）
node evc.js commit -m "msg"       # 快照 evidence/ 与 claims.json 为新版本
node evc.js verify [version]      # 增量校验 genesis..version（默认 HEAD）
node evc.js checkout <ver> [dir]  # 检出指定版本到 dir（默认 ./checkout）
```

退出码：0 成功；1 用法/IO 错误；2 校验失败（证据缺失 `MISSING_EVIDENCE`、
哈希不符 `HASH_MISMATCH`、claim 引用被删证据 `DANGLING_CLAIM`、版本对象损坏 `CORRUPT_VERSION`）。

## 测试

```sh
node --test
```

测试真实输出见 `test-result.txt`。
