# Hudi timeline instant 裁决

增量读取器要可直接接入 Go Hudi timeline 状态库，解析 requested/inflight/completed instant、rollback、restore 与 replace commit。相同时间戳的状态按合法转移合并，已回滚 commit 不进入增量范围；归档 timeline 与 active timeline 重叠时内容必须一致，查询返回证据链。
