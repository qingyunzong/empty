# wo-index — 维修工单备注离线检索

Node.js 22，仅标准库，单机离线。位置倒排索引 + 批次撤销。

## 用法

```sh
# add: JSONL 输入 {"id","text"}，一次调用 = 一个批次
printf '%s\n' '{"id":"wo1","text":"轴承 过热 停机"}' | node bin/wo.js add --dir .woindex

# del: JSONL 输入 {"id"}（墓碑删除）
echo '{"id":"wo1"}' | node bin/wo.js del --dir .woindex

# query: JSONL 输入 {"q"}；短语 "轴承 过热"，近邻 "轴承 NEAR/2 过热"
echo '{"q":"轴承 NEAR/2 过热"}' | node bin/wo.js query --dir .woindex

# undo: 回滚到指定批次（缺省回滚最近一批）
node bin/wo.js undo --dir .woindex --to 2

# verify: 校验日志哈希链 + 重放哈希 == 存储哈希
node bin/wo.js verify --dir .woindex
```

输出均为 JSON；失败输出 `{"ok":false,"error":{"code,...}}` 且退出码非 0，状态不变。

## 设计

- `batches.log`：追加式批次日志，每条 `{seq, prev, ops, hash}` 构成哈希链，是事实源。
- `segments/seg-N.json`：词项 → 文档 → 位置（delta 编码 + varint + base64）。
- 删除记墓碑；段数达到阈值时增量合并，物理剔除墓碑文档，已删短语不会复活。
- 索引哈希只覆盖逻辑内容（与段布局无关），undo = 截断日志并重放前缀，
  因此重放哈希恒等于重建哈希。
- 排序：命中数降序，并列按文档 id 升序。

## 错误码

`E_PARSE`（输入/查询格式错误）、`E_NOTFOUND`（删除不存在的工单）、
`E_UNDO`（非法回滚目标）、`E_CORRUPT`（日志链/哈希/varint 校验失败）。

## 测试

```sh
node --test
```
