# woindex — 离线工单备注检索（位置倒排 + 版本撤销）

Node.js 22，仅标准库，单机离线。为维修班离线终端提供工单备注的短语 / NEAR 检索，
支持按批次（工单版本录入）撤销错误录入，并可校验索引与日志完整性。

## 运行

```bash
node --test          # 全部测试
node cli.js --dir <数据目录> <add|del|undo|query|verify>   #  stdin 为 JSONL，stdout 为 JSON
```

### add（一批 = 一次 CLI 调用内的全部行）
```bash
echo '{"id":"WO-1001","version":1,"text":"巡检发现3号泵轴承过热，立即停机"}' | node cli.js add
# => {"ok":true,"batch":1,"count":1}
```

### del（墓碑删除；省略 version 删除该工单全部版本）
```bash
echo '{"id":"WO-1001","version":1}' | node cli.js del
```

### undo（按批次撤销；{to:k} 回滚到批次 k）
```bash
echo '{"batch":2}' | node cli.js undo
# => {"ok":true,"reverted":[2],"indexHash":"...","rebuildHash":"..."}  两哈希相等
```

### query（每行一个查询，逐行输出）
```bash
printf '{"phrase":"轴承 过热"}\n{"near":["轴承","过热"],"k":2}\n{"term":"泵"}\n' | node cli.js query
# => {"ok":true,"results":[{"id":"WO-1001","version":1,"matches":[[7,10]]}]}
```

### verify（校验日志哈希链、索引哈希、varint 段完整性）
```bash
node cli.js verify
# => {"ok":true,"batches":2,"reverted":[],"docs":1,"indexHash":"...","journalHash":"..."}
```

## 设计

- **分词**：CJK 单字成词、ASCII 字母数字run成词（小写化），其余为分隔符；位置按 token 递增。
  查询词（如“轴承”）编译为 token 序列，因此短语“轴承 过热”等价于连续序列 轴-承-过-热。
- **位置倒排**：`term -> docKey -> 有序位置`，docKey = `工单号 \u0001 版本`。
  NEAR/k 为两词项跨度间隔 ≤ k（k 为间隔 token 数，默认 3）。
- **段与墓碑**：每批写一个 varint 压缩段（`segments/seg-*.json`），删除写墓碑。
  折叠（增量合并）按批次序应用：新段的墓碑先清除累计结果中的该 docKey，再并入新 posting，
  已删短语不会复活。段数超过阈值生成 compact 快照（仅含存活 posting）；撤销覆盖到
  快照内批次时快照失效，保证正确性。
- **撤销**：每批在日志中记录每个 docKey 的 before/after 镜像（undo 记录）。
  撤销批次 n：逆序回退 n 之后的有效批次 → 回退 n → 重放其余批次；
  重放结果的索引哈希必须与重建哈希相等，否则报 E_CORRUPT。
- **完整性**：`journal.jsonl` 逐行哈希链（sha256(prev + canonical(body))）；
  `state.json` 记录最新 indexHash/journalHash；`verify` 重放整条链、
  重折段、并对每段做 varint 解码-重编码一致性检查。
- **错误码**：`E_PARSE`（输入非法）、`E_NOTFOUND`（删除/撤销目标不存在）、
  `E_UNDO`（重复撤销或撤销非数据批次）、`E_CORRUPT`（哈希链/索引不一致）。
  所有校验先于任何写入，失败不改状态。

## 文件

- `src/tokenize.js` 分词 / 查询词编译
- `src/index.js` 位置倒排索引、短语与 NEAR 查询、canonical 哈希
- `src/varint.js` LEB128 varint 与段 posting 编解码（位置 delta 编码）
- `src/store.js` 日志、段折叠、撤销重放、压缩、verify
- `cli.js` 命令行入口（`main(argv, stdin)` 可进程内调用）
