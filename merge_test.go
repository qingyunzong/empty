package kvmerge

import (
	"strings"
	"testing"
)

func ent(key string, seq uint64, val string) Entry { return Entry{Key: key, Seq: seq, Val: val} }
func del(key string, seq uint64) Entry             { return Entry{Key: key, Seq: seq, Del: true} }

func decisionFor(res Result, key string, seq uint64) Decision {
	for _, d := range res.Decisions {
		if d.Entry.Key == key && d.Entry.Seq == seq {
			return d
		}
	}
	return Decision{}
}

func TestTombstoneRetainedAboveBottom(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("k", 1, "a"), del("k", 5)})
	res := Merge([]Segment{seg}, nil, false)
	if len(res.Output) != 1 || !res.Output[0].Del {
		t.Fatalf("未到最底层时墓碑必须保留，输出: %v", res.Output)
	}
	d := decisionFor(res, "k", 5)
	if !d.Kept || !strings.Contains(d.Reason, "下层") {
		t.Fatalf("墓碑保留原因应提及下层旧值可能复活: %+v", d)
	}
	if d1 := decisionFor(res, "k", 1); d1.Kept {
		t.Fatalf("被墓碑遮蔽且无读者需要的旧值应丢弃: %+v", d1)
	}
}

func TestTombstoneDroppedAtBottom(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("k", 1, "a"), del("k", 5)})
	res := Merge([]Segment{seg}, nil, true)
	if len(res.Output) != 0 {
		t.Fatalf("最底层且无快照时墓碑与旧值都应删除，输出: %v", res.Output)
	}
	d := decisionFor(res, "k", 5)
	if d.Kept || !strings.Contains(d.Reason, "不可能复活") {
		t.Fatalf("墓碑删除原因应说明旧值不可能复活: %+v", d)
	}
}

func TestTombstoneKeptWhenSnapshotSeesOlderValue(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("k", 1, "a"), del("k", 5)})
	res := Merge([]Segment{seg}, []uint64{2}, true)
	if len(res.Output) != 2 {
		t.Fatalf("快照仍可见旧值时，旧值与墓碑都必须保留，输出: %v", res.Output)
	}
	if v, ok := res.Get("k", 2); !ok || v != "a" {
		t.Fatalf("快照 seq=2 应看到 a，得到 %q, %v", v, ok)
	}
	if _, ok := res.Get("k", LatestSeq); ok {
		t.Fatal("最新读应看到键已删除")
	}
	d := decisionFor(res, "k", 5)
	if !d.Kept || !strings.Contains(d.Reason, "复活") {
		t.Fatalf("墓碑保留原因应说明删除会导致旧值复活: %+v", d)
	}
}

func TestVersionsKeptPerSnapshot(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("k", 1, "a"), ent("k", 3, "b"), ent("k", 7, "c")})
	res := Merge([]Segment{seg}, []uint64{5}, true)
	if len(res.Output) != 2 {
		t.Fatalf("应保留 seq=7（最新读）与 seq=3（快照 seq=5 可见），输出: %v", res.Output)
	}
	if v, _ := res.Get("k", 5); v != "b" {
		t.Fatalf("快照 seq=5 应看到 b，得到 %q", v)
	}
	if v, _ := res.Get("k", LatestSeq); v != "c" {
		t.Fatalf("最新读应看到 c，得到 %q", v)
	}
	if d := decisionFor(res, "k", 1); d.Kept {
		t.Fatalf("seq=1 无读者需要，应丢弃: %+v", d)
	}
}

func TestSnapshotSeesNothingBeforeFirstWrite(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("k", 4, "a")})
	res := Merge([]Segment{seg}, []uint64{2}, true)
	if _, ok := res.Get("k", 2); ok {
		t.Fatal("首次写入之前的快照不应看到任何值")
	}
	if len(res.Output) != 1 {
		t.Fatalf("只应保留最新版本，输出: %v", res.Output)
	}
}

func TestMultiSegmentNewestWins(t *testing.T) {
	segNew := NewSegment(0, []Entry{ent("k", 6, "new")})
	segOld := NewSegment(1, []Entry{ent("k", 2, "old"), del("k", 4)})
	res := Merge([]Segment{segNew, segOld}, nil, false)
	if v, ok := res.Get("k", LatestSeq); !ok || v != "new" {
		t.Fatalf("最新读应看到 new，得到 %q, %v", v, ok)
	}
	// 墓碑 seq=4 对任何已注册读者都不可见（最新读看到 seq=6），可丢弃。
	if d := decisionFor(res, "k", 4); d.Kept {
		t.Fatalf("不可见的墓碑应丢弃: %+v", d)
	}
	if d := decisionFor(res, "k", 2); d.Kept {
		t.Fatalf("被遮蔽的旧值应丢弃: %+v", d)
	}
}

func TestEveryDecisionHasReason(t *testing.T) {
	seg := NewSegment(0, []Entry{ent("a", 1, "x"), ent("a", 2, "y"), del("a", 3), ent("b", 1, "z")})
	res := Merge([]Segment{seg}, []uint64{1, 2}, true)
	if len(res.Decisions) != 4 {
		t.Fatalf("决策数应等于输入条目数，得到 %d", len(res.Decisions))
	}
	for _, d := range res.Decisions {
		if d.Reason == "" {
			t.Fatalf("条目 %v 缺少去留原因", d.Entry)
		}
	}
}
