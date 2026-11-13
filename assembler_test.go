package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func begin(txn, shard string, pos uint64, shards ...string) Event {
	return Event{Shard: shard, TxnID: txn, Kind: EventBegin, Pos: pos, Shards: shards}
}

func row(txn, shard string, pos uint64, key, val string) Event {
	return Event{Shard: shard, TxnID: txn, Kind: EventRow, Pos: pos,
		Row: Row{Op: "insert", Key: key, Value: []byte(val)}}
}

func commit(txn, shard string, pos, seq uint64) Event {
	return Event{Shard: shard, TxnID: txn, Kind: EventCommit, Pos: pos, GlobalSeq: seq}
}

// feed 应用事件并汇总所有返回的批次。
func feed(t *testing.T, a *Assembler, evs ...Event) []*Batch {
	t.Helper()
	var batches []*Batch
	for _, ev := range evs {
		b, err := a.Apply(ev)
		if err != nil {
			t.Fatalf("Apply(%+v) error: %v", ev, err)
		}
		if b != nil {
			batches = append(batches, b)
		}
	}
	return batches
}

func TestSingleShardPublishesOnCommit(t *testing.T) {
	a := New()
	if batches := feed(t, a,
		begin("t1", "s1", 1, "s1"),
		row("t1", "s1", 2, "k1", "v1"),
	); len(batches) != 0 {
		t.Fatalf("unexpected publish before commit: %+v", batches)
	}
	batches := feed(t, a, commit("t1", "s1", 3, 1))
	if len(batches) != 1 {
		t.Fatalf("want 1 batch, got %d", len(batches))
	}
	b := batches[0]
	if b.Watermark != 1 || a.Watermark() != 1 {
		t.Fatalf("watermark = %d/%d, want 1", b.Watermark, a.Watermark())
	}
	want := []PublishedTxn{{
		TxnID: "t1", GlobalSeq: 1,
		Rows: []PublishedRow{{Shard: "s1", Pos: 2, Op: "insert", Key: "k1", Value: []byte("v1")}},
	}}
	if !reflect.DeepEqual(b.Txns, want) {
		t.Fatalf("txns = %+v, want %+v", b.Txns, want)
	}
}

func TestVisibleOnlyAfterAllDeclaredShards(t *testing.T) {
	a := New()
	if batches := feed(t, a,
		begin("t1", "s1", 1, "s1", "s2"),
		row("t1", "s1", 2, "a", "1"),
		commit("t1", "s1", 3, 1),
		begin("t1", "s2", 1),
		row("t1", "s2", 2, "b", "2"),
	); len(batches) != 0 {
		t.Fatalf("published before all shards committed: %+v", batches)
	}
	if wm := a.Watermark(); wm != 0 {
		t.Fatalf("watermark advanced to %d before completeness", wm)
	}
	batches := feed(t, a, commit("t1", "s2", 3, 1))
	if len(batches) != 1 || len(batches[0].Txns) != 1 {
		t.Fatalf("want 1 batch with 1 txn, got %+v", batches)
	}
	got := batches[0].Txns[0]
	wantRows := []PublishedRow{
		{Shard: "s1", Pos: 2, Op: "insert", Key: "a", Value: []byte("1")},
		{Shard: "s2", Pos: 2, Op: "insert", Key: "b", Value: []byte("2")},
	}
	if !reflect.DeepEqual(got.Rows, wantRows) {
		t.Fatalf("rows = %+v, want %+v", got.Rows, wantRows)
	}
}

func TestWatermarkOnlyCrossesCompleteTxns(t *testing.T) {
	a := New()
	// t2（全局序 2）先完整，但 t1（全局序 1）未完成，水位不得越过。
	feed(t, a,
		begin("t2", "s1", 1, "s1"),
		row("t2", "s1", 2, "x", "2"),
		commit("t2", "s1", 3, 2),
		begin("t1", "s1", 4, "s1"),
		row("t1", "s1", 5, "y", "1"),
	)
	if wm := a.Watermark(); wm != 0 {
		t.Fatalf("watermark = %d, want 0 while t1 incomplete", wm)
	}
	batches := feed(t, a, commit("t1", "s1", 6, 1))
	if len(batches) != 1 {
		t.Fatalf("want 1 batch, got %d", len(batches))
	}
	b := batches[0]
	if b.Watermark != 2 {
		t.Fatalf("batch watermark = %d, want 2", b.Watermark)
	}
	if len(b.Txns) != 2 || b.Txns[0].TxnID != "t1" || b.Txns[1].TxnID != "t2" {
		t.Fatalf("batch txns out of order: %+v", b.Txns)
	}
}

func TestDuplicateFragmentsDedupedByPosition(t *testing.T) {
	a := New()
	batches := feed(t, a,
		begin("t1", "s1", 1, "s1"),
		row("t1", "s1", 2, "k", "v"),
		begin("t1", "s1", 1, "s1"), // 重放
		row("t1", "s1", 2, "k", "v"),
		row("t1", "s1", 2, "k", "v"),
		commit("t1", "s1", 3, 1),
		commit("t1", "s1", 3, 1), // 重放
	)
	if len(batches) != 1 {
		t.Fatalf("want 1 batch, got %d", len(batches))
	}
	rows := batches[0].Txns[0].Rows
	if len(rows) != 1 {
		t.Fatalf("dedup failed, rows = %+v", rows)
	}
}

func TestRowConflictQuarantinesAndStallsWatermark(t *testing.T) {
	a := New()
	feed(t, a,
		begin("t1", "s1", 1, "s1"),
		row("t1", "s1", 2, "k", "v1"),
		row("t1", "s1", 2, "k", "v2"), // 同位置内容冲突
	)
	q := a.Quarantined()
	if len(q) != 1 || q["t1"] == "" {
		t.Fatalf("t1 not quarantined: %v", q)
	}
	// 隔离后事件被忽略，包括提交。
	if batches := feed(t, a, commit("t1", "s1", 3, 1)); len(batches) != 0 {
		t.Fatalf("quarantined txn published: %+v", batches)
	}
	if wm := a.Watermark(); wm != 0 {
		t.Fatalf("watermark crossed quarantined txn: %d", wm)
	}
	// 运维确认后跳过，水位放行。
	b, err := a.Skip("t1")
	if err != nil {
		t.Fatalf("Skip: %v", err)
	}
	if b != nil {
		t.Fatalf("skip must not publish txns, got %+v", b)
	}
	if wm := a.Watermark(); wm != 1 {
		t.Fatalf("watermark = %d after skip, want 1", wm)
	}
	if len(a.Quarantined()) != 0 {
		t.Fatalf("skipped txn still listed as quarantined")
	}
}

func TestConflictingDeclarationsQuarantine(t *testing.T) {
	a := New()
	feed(t, a,
		begin("t1", "s1", 1, "s1", "s2"),
		begin("t1", "s2", 1, "s1", "s2", "s3"),
	)
	if _, ok := a.Quarantined()["t1"]; !ok {
		t.Fatalf("shard-set conflict not quarantined")
	}

	a2 := New()
	feed(t, a2,
		begin("t1", "s1", 1, "s1"),
		commit("t1", "s1", 2, 1),
		commit("t1", "s1", 3, 2), // 同分片不同全局序
	)
	if _, ok := a2.Quarantined()["t1"]; !ok {
		t.Fatalf("global-seq conflict not quarantined")
	}
}

func TestUndeclaredShardQuarantines(t *testing.T) {
	// 声明后收到未声明分片的事件。
	a := New()
	feed(t, a,
		begin("t1", "s1", 1, "s1"),
		row("t1", "s9", 1, "k", "v"),
	)
	if _, ok := a.Quarantined()["t1"]; !ok {
		t.Fatalf("event from undeclared shard not quarantined")
	}

	// 声明到达前已收到未声明分片的事件，声明时回溯校验。
	a2 := New()
	feed(t, a2,
		row("t1", "s9", 1, "k", "v"),
		begin("t1", "s1", 1, "s1"),
	)
	if _, ok := a2.Quarantined()["t1"]; !ok {
		t.Fatalf("late declaration did not catch undeclared shard")
	}
}

func TestInvalidEventsRejected(t *testing.T) {
	a := New()
	for _, ev := range []Event{
		{Shard: "", TxnID: "t", Kind: EventBegin},
		{Shard: "s", TxnID: "", Kind: EventBegin},
		{Shard: "s", TxnID: "t", Kind: 0},
		{Shard: "s", TxnID: "t", Kind: EventCommit}, // 缺全局序
	} {
		if err := mustApply(a, ev); !errors.Is(err, ErrInvalidEvent) {
			t.Fatalf("Apply(%+v) = %v, want ErrInvalidEvent", ev, err)
		}
	}
}

func mustApply(a *Assembler, ev Event) error {
	_, err := a.Apply(ev)
	return err
}

// mixedScript 构造一段涵盖多分片、乱序全局序、重放重复的事件流。
func mixedScript() []Event {
	return []Event{
		begin("t1", "s1", 1, "s1", "s2"),
		row("t1", "s1", 2, "a", "1"),
		begin("t2", "s1", 3, "s1"),
		row("t2", "s1", 4, "b", "2"),
		commit("t2", "s1", 5, 2), // t2 先完整但序号为 2，水位等待 t1
		begin("t1", "s2", 1),
		row("t1", "s2", 2, "c", "3"),
		row("t1", "s2", 2, "c", "3"), // 重放去重
		commit("t1", "s1", 6, 1),
		commit("t1", "s2", 3, 1), // t1 完整，水位越过 1、2
		begin("t3", "s2", 4, "s2"),
		row("t3", "s2", 5, "d", "4"),
		commit("t3", "s2", 6, 3),
	}
}

func collect(t *testing.T, a *Assembler, evs []Event) []*Batch {
	t.Helper()
	var batches []*Batch
	for _, ev := range evs {
		b, err := a.Apply(ev)
		if err != nil {
			t.Fatalf("Apply(%+v): %v", ev, err)
		}
		if b != nil {
			batches = append(batches, b)
		}
	}
	return batches
}

func TestReplayProducesIdenticalBatches(t *testing.T) {
	script := mixedScript()
	first := collect(t, New(), script)
	second := collect(t, New(), script)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("replay diverged:\nfirst  %+v\nsecond %+v", first, second)
	}
	if len(first) != 2 {
		t.Fatalf("want 2 batches from script, got %d: %+v", len(first), first)
	}
	// 第一个批次应包含 t1、t2 两个事务且按序排列。
	if got := first[0].Txns; len(got) != 2 || got[0].TxnID != "t1" || got[1].TxnID != "t2" {
		t.Fatalf("unexpected first batch: %+v", got)
	}
}

func TestSnapshotRestoreKeepsReplayDeterministic(t *testing.T) {
	script := mixedScript()
	full := collect(t, New(), script)

	// 应用前半段后做快照，恢复后继续，批次必须与全量重放一致。
	const cut = 6
	a := New()
	var viaSnapshot []*Batch
	viaSnapshot = append(viaSnapshot, collect(t, a, script[:cut])...)
	data, err := a.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	restored, err := Restore(data)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	viaSnapshot = append(viaSnapshot, collect(t, restored, script[cut:])...)

	if !reflect.DeepEqual(full, viaSnapshot) {
		t.Fatalf("snapshot restore diverged:\nfull   %+v\nrestore %+v", full, viaSnapshot)
	}
	if restored.Watermark() != 3 {
		t.Fatalf("restored watermark = %d, want 3", restored.Watermark())
	}
}

func TestConcurrentApply(t *testing.T) {
	a := New()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			_, _ = a.Apply(row("t1", "s1", uint64(i+2), "k", "v"))
		}
	}()
	feed(t, a, begin("t1", "s1", 1, "s1"))
	<-done
	if wm := a.Watermark(); wm != 0 {
		t.Fatalf("unexpected watermark %d", wm)
	}
}
