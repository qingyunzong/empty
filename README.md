# supplier_saga

供应商选择 saga：并发收集报价 -> 按 (价格, id) 排序候选 -> 依次预留 ->
成功即 COMPLETED；支持取消补偿与基于事件日志的崩溃恢复。
纯 Python 3.11 标准库实现。

## 供应商输入（JSON）

```json
[{"id": "s1", "price": 100, "latency": 10, "quote_failed": false, "reserve_failed": false}]
```

## 命令

```bash
python supplier_saga.py run     --suppliers suppliers.json --db journal.json
python supplier_saga.py crash   --suppliers suppliers.json --db journal.json --at quote:s1
python supplier_saga.py recover --db journal.json [--at reserve:s1]
python supplier_saga.py cancel  --db journal.json
python supplier_saga.py state   --db journal.json
```

崩溃事件键：`quote:<id>`、`quotes`、`reserve:<id>`、`reserve_fail:<id>`、`compensate:<id>`。

## 语义

- 报价按 (延迟, id) 顺序完成（模拟并发收集），失败报价剔除。
- 候选按价格升序、同价按 id 升序；依次预留，失败回退次选。
- 无可用报价或全部预留失败 -> FAILED。
- RESERVING 前取消：不预留任何供应商，直接 CANCELED；
  预留成功后取消：CANCELING -> 补偿已预留者 -> CANCELED。
- 报价/预留/补偿均按请求键幂等（`quote:<id>` 等），恢复时不重复发起。

## 测试

```bash
python -m unittest -v > result.txt 2>&1
```
