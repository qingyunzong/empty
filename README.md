# 自增键高水位追赶

`example.org/dataeng/q0184` 提供与数据库驱动无关的 Go 高水位组件，用于按自增主键做快照和增量追赶。

## 行为保证

- `CaptureSnapshot` 只读取一次 `MAX(id)`，把它固定为当前世代的闭区间上限；`Snapshot.Next` 产生的每个分块都满足 `Through <= Ceiling`。
- 快照期间写入的新记录键值大于上限，自动留给 `NextGeneration`，不会混入当前快照。
- 分块按主键区间而不是行数描述。删除留下的空洞不会阻塞推进：即使区间内零行，也可以 `CommitThrough`。
- `MAX(id)` 不是完整性证明。人工插入低键不会改变 MAX，回绕/复用又会与“删除最高行”表现相同，因此 `MaxWatch` 始终标记 `ChangeLogRequired`；`KeyGuard` 会把低键和乱序键标为需要补偿。
- 有变更日志时，用 `ChangeLogPosition` 记录世代起点，并通过 `KeyGuard`/`MaxWatch` 的告警触发补偿。组件不猜测回绕。

## 快照用法

```go
type maxSource struct{ db *sql.DB }

func (s maxSource) MaxAutoIncrementKey(ctx context.Context) (dataeng.Key, error) {
	var max int64
	err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM items").Scan(&max)
	return max, err
}

snap, err := dataeng.CaptureSnapshot(ctx, maxSource{db}, dataeng.WithStartKey(1))
if err != nil {
	return err
}

sc := dataeng.NewScanner(snap)
for {
	chunk, more, err := sc.Next(1000)
	if err != nil {
		return err
	}
	if !more {
		break
	}

	// After.Set 时用 id > After.Key，否则用 id >= From。
	rows, err := readRange(ctx, db, chunk)
	if err != nil {
		return err
	}
	if err := storeRows(rows); err != nil {
		return err
	}
	// 区间内可能全是已删除的空洞；提交整个区间，不要按行数推进。
	if err := sc.CommitThrough(); err != nil {
		return err
	}
}
```

推荐的区间查询形状是：

```sql
SELECT id, payload
FROM items
WHERE id > :after AND id <= :through
ORDER BY id
LIMIT :limit;
```

首次分块没有 `after`，改成 `id >= :from AND id <= :through`。

断点续扫时用 `NewScannerAt(snap, dataeng.After(lastCommittedKey))`。如果读取被提前截断，可用 `sc.AdvanceTo(lastReturnedKey)` 只推进到实际读到的位置；其余区间会在下一次 `Next` 中重新规划。

## 增量世代

```go
next, err := snap.NextGeneration(currentMax, dataeng.ChangeLogPosition("binlog.000042:8123"))
```

新世代只扫描 `(旧 Ceiling, 新 Ceiling]`。如果新的 `MAX(id)` 小于旧上限，没有变更日志时 `NextGeneration` 返回 `ErrMaxRegressed`：这可能是删除最高行，也可能是回绕，不能只凭 MAX 判断。提供变更日志后上限不会回退，低键修正由日志补偿。

对于确定只追加、单调递增且禁止人工低键插入的表，可以传空 `ChangeLogPosition`，但 `Snapshot.Authoritative()` 会返回 false，调用方必须明确接受这一限制。

## 边界

- 键类型为 `int64` 且要求非负；适用于常规自增主键。
- `Next` 的加减法使用无符号差值计算，`math.MaxInt64` 附近不会溢出。
- `Scanner` 不是并发安全的；每个世代使用独立的 scanner。
- 组件不执行 SQL。快照上限与后续读取必须来自同一个一致性视图/事务，否则两者可能不匹配。
