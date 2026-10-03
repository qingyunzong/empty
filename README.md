# Event-Ledger Certificate (ELC1)

Append/correct 事件流 → 事件时间窗口 → 可离线验证的哈希链证书。仅使用 Node.js 22 标准库与 `node:test`。

## 用法

```sh
# 构建证书（JSONL 输入：{seq,eventTime,type,acct,amount,ref}）
node cli.js audit build --in a.jsonl --out r.json [--window-size 3600] [--lateness 0] [--naive]

# 离线验证；任何字段被篡改退出码为 4，并定位到窗口
node cli.js audit verify --in r.json

node --test
```

## 语义

- **窗口**：`windowId = floor(eventTime / windowSize)`；窗口内事件按 `seq`（ingest 顺序）排序。
- **水位线**：`watermark = maxEventTime - lateness`；`window.end <= watermark` 即 sealed，
  之后到达的迟到事件只进入 `appendix`（`SEALED_WINDOW`），不影响已 sealed 窗口的合计。
- **版本链**：`append` 建立版本；`correct` 通过 `ref` 指向原 seq，金额影响为
  `新amount - 上一生效版本amount`（amount=0 即完全撤销）。同一 seq 仅最新版本生效。
- **错误**：`ref` 悬空记 `DANGLING` 并继续；`ref >= seq` 且该 seq 在日志中存在记 `FUTURE_REF`；
  两者都不产生金额影响，但事件仍被哈希进窗口以保证完整性。
- **--naive**：事件数 ≤150 时，独立重放全部版本链重算各窗口合计与 appendix 数量并对照。

## 哈希域分隔（SHA-256，前缀 `ELC1:<domain>:`）

- `header`：窗口头 `{id,start,end,prev}`，`prev` 链接前一窗口哈希形成链。
- `event`：单条事件记录（含派生字段 window/applied/error）。
- `window`：`{header, events[], totals}`。
- `appendix` / `appendix-list`：appendix 条目与列表。
- `root`：`{version, params, windows[], appendix, errors}`，即报告根哈希。

## 验证

`verify` 从报告中的事件重建整个证书（窗口划分、版本链、合计、appendix、全部哈希与 root），
逐字段对照；任一字段被篡改都会失配，输出首个失配窗口并以退出码 4 结束。

