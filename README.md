# evchain — 证据链版本库与 CLI

单机离线、Node.js 22、仅标准库。每个版本记录：父版本哈希、证据文件路径、内容
SHA-256、claim 列表，以及相对父版本的结构化补丁（added / modified / removed /
claims 增删）。版本哈希 = 版本对象规范化 JSON 的 SHA-256。

## 布局

- `evidence/` — 工作区证据文件（commit 的输入）
- `claims.json` — 工作区声明，`[{id, text, evidence: [path, ...]}]`
- `.evchain/objects/` — 内容寻址的证据 blob
- `.evchain/versions/<hash>.json` — 版本对象（含 patch）
- `.evchain/certs/<hash>.json` — verify 通过后生成的证书（contentHash + parentHash）
- `checkout/` — checkout 输出目录（先构建临时目录再原子替换）

## CLI

```sh
node evc.js init
node evc.js commit -m "message"
node evc.js verify <version-hash>
node evc.js checkout <version-hash>
```

退出码：`0` 成功；`1` 校验/提交失败；`2` checkout 目标版本损坏（原已检出目录保持不变）。

## 语义

- **verify**：从创世版本沿父链增量重放到目标版本，逐版本校验：版本对象哈希、
  补丁能否重放出版本清单、每个证据 blob 存在且 SHA-256 相符、claim 不引用
  已删除证据。全部通过后生成证书。
- **commit**：若 claim 引用了不存在的证据（如证据已被删除），以
  `DANGLING_CLAIM` 失败且 HEAD 不移动。
- **checkout**：先完整 verify，再从对象库重建该版本完整清单（不依赖工作区当前
  状态）；目标损坏时退出码 2，已有检出目录原样保留。

## 错误状态

`MISSING_EVIDENCE`（证据缺失）、`HASH_MISMATCH`（blob 或版本对象哈希不符）、
`DANGLING_CLAIM`（声明引用被删证据）、`PATCH_MISMATCH`、`CORRUPT_VERSION`。

## 测试

```sh
node --test        # 结果见 test-result.txt
```

覆盖：连续提交后检出旧版本、篡改证据被发现、缺失证据、版本对象被篡改、
删除被引用证据导致提交失败、损坏版本 checkout 退出码 2 且原检出目录不变；
并对 4 个版本（创世 + 3 次提交）的链枚举所有篡改位置（每个版本 × 每个证据
文件）作独立子测试。
