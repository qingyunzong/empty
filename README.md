# alarm-manual-retrieval

控制室报警手册离线检索库与 CLI。Node.js 22，仅标准库，单机离线。

## 功能

- 词项词典：词典按字典序排序，词项 = ASCII 字母数字 / CJK 表意文字的最长连续串
  （`原因码C101`、`T201` 等报警码是单一词项），标点与空白仅作分隔符。
- token 位置：文档级单调递增位置；空行划分段落，记录每段起始位置。
  短语与近邻命中不得跨段。
- posting 按块压缩：每块 4 个文档条目，varint 差分编码后 deflate 压缩；
  块头存 `maxDocId` 与位置基数 `posBase`，`advance()` 仅凭块头跳过整块（不解压）。
- 删除墓碑：`del` 只立墓碑，查询时过滤；`compact` 物理清除并重建 posting。
- 证书：`compact` 签发证书，含词项数、删除数、排序根哈希（按词典序对
  每个词项的规范 posting 哈希后再哈希）；证书通过 `prevHash` 构成仅追加链，
  旧证书可证明历史。
- 排序：短语命中数降序 → 最小跨度升序 → docID 升序（全序，并列稳定）。

## 查询语法

```
"泵 气蚀"                短语（引号可省）
泵                       单词项
原因码C1 NEAR/4 处理码T1  近邻：两词项之间至多 k 个词（k=0 表示相邻）
```

## CLI

```
node cli.js build   <dir>                初始化空索引
node cli.js index   <dir> <file...>      索引文档（id = 文件名去扩展名）
node cli.js del     <dir> <docId...>     立删除墓碑
node cli.js compact <dir>                压实并签发证书
node cli.js query   <dir> <query>        查询，输出 docId/hits/span
node cli.js cert    <dir>                校验并打印证书链
```

错误码：`E_TOKEN`（空词项/非法词项）、`E_SPAN`（非法跨度）、`E_CERT`（证书校验失败）。

## 测试

```
node --test
```

验收覆盖：k=0/k=4/k=5 边界；与逐词枚举参考算法对照全部查询（含删除与
compact 后）；删除后 compact 证书变化且旧证书可证历史；空词项与跨段短语不命中。
