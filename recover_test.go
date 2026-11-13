package dataeng

import (
	"reflect"
	"testing"
)

func TestFreshStartTail(t *testing.T) {
	j := newFakeJournal([]*Entry{entry("boot-a", 100, 10, "old")})
	c, err := Open(j, State{}, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if c.Mode() != ResumeFresh {
		t.Fatalf("mode = %v, want fresh", c.Mode())
	}
	if got := drain(t, c); len(got) != 0 {
		t.Fatalf("tail start should emit nothing, got %v", messages(got))
	}
}

func TestFreshStartHead(t *testing.T) {
	j := newFakeJournal([]*Entry{
		entry("boot-a", 100, 10, "m1"),
		entry("boot-a", 200, 20, "m2"),
	})
	c, err := Open(j, State{}, &Options{StartAtHead: true})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got := drain(t, c)
	if want := []string{"m1", "m2"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestResumeFromValidCursor(t *testing.T) {
	entries := []*Entry{
		entry("boot-a", 100, 10, "m1"),
		entry("boot-a", 200, 20, "m2"),
		entry("boot-a", 300, 30, "m3"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[0])

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if c.Mode() != ResumeCursor {
		t.Fatalf("mode = %v, want cursor", c.Mode())
	}
	got := drain(t, c)
	if want := []string{"m2", "m3"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
	// 状态推进到最后一条投递的条目。
	if st := c.State(); st.Cursor != entries[2].Cursor || st.Realtime != 300 || st.Monotonic != 30 {
		t.Fatalf("state = %+v, want cursor of m3", st)
	}
}

func TestResumeAfterVacuumBackfillsByTime(t *testing.T) {
	entries := []*Entry{
		entry("boot-a", 100, 10, "m1"),
		entry("boot-a", 200, 20, "m2"),
		entry("boot-a", 300, 30, "m3"),
		entry("boot-a", 400, 40, "m4"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[1]) // 消费到 m2

	j.vacuum(2) // m1、m2 被清理，saved.Cursor 失效

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if c.Mode() != ResumeBackfill {
		t.Fatalf("mode = %v, want backfill", c.Mode())
	}
	got := drain(t, c)
	if want := []string{"m3", "m4"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestBackfillFiltersCoveredEntries(t *testing.T) {
	// saved 之后同一 realtime 上还有同 boot 的条目（monotonic 更大），
	// 以及 realtime 更小的旧条目，都应被过滤。
	entries := []*Entry{
		entry("boot-a", 200, 15, "older-same-realtime"),
		entry("boot-a", 200, 20, "saved"),
		entry("boot-a", 200, 25, "newer-same-realtime"),
		entry("boot-a", 300, 30, "newer"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[1])
	saved.Cursor = "s=vacuumed;i=0" // 游标对应条目已被清理，但旧条目仍在

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got := drain(t, c)
	if want := []string{"newer-same-realtime", "newer"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestBackfillDoesNotCompareMonotonicAcrossBoots(t *testing.T) {
	// saved 在 boot-a；boot-b 的条目 monotonic 更小但 realtime 更新，
	// 跨 boot 单调时间不可比，必须投递。
	entries := []*Entry{
		entry("boot-a", 200, 20, "saved"),
		entry("boot-b", 200, 5, "other-boot-same-realtime"),
		entry("boot-b", 300, 6, "other-boot-newer"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[0])
	j.vacuum(1)

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got := drain(t, c)
	if want := []string{"other-boot-same-realtime", "other-boot-newer"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestBackfillDedupesByUniqueFields(t *testing.T) {
	// journal 重叠区间返回重复条目（唯一字段集相同、游标不同），
	// 补扫结果必须去重。
	dup := entry("boot-a", 300, 30, "m2")
	entries := []*Entry{
		entry("boot-a", 200, 20, "m1"),
		entry("boot-a", 300, 30, "m2"),
		dup,
		entry("boot-a", 400, 40, "m3"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[0])
	j.vacuum(1)

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got := drain(t, c)
	if want := []string{"m2", "m3"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestBackfillDedupSeededWindow(t *testing.T) {
	// 跨 boot realtime 相同的条目无法靠时间过滤，
	// 调用方补种历史键后由去重窗口吸收。
	entries := []*Entry{
		entry("boot-a", 200, 20, "saved"),
		entry("boot-b", 200, 5, "already-shipped"),
		entry("boot-b", 300, 6, "new"),
	}
	j := newFakeJournal(entries)
	saved := stateFromEntry(entries[0])
	j.vacuum(1)

	c, err := Open(j, saved, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	c.Deduper().Seen(entries[1]) // 补种：该条目上次已投递

	got := drain(t, c)
	if want := []string{"new"}; !reflect.DeepEqual(messages(got), want) {
		t.Fatalf("got %v, want %v", messages(got), want)
	}
}

func TestOpenRejectsInvalidState(t *testing.T) {
	j := newFakeJournal(nil)
	if _, err := Open(j, State{Cursor: "c"}, nil); err == nil {
		t.Fatal("expected error for state without realtime")
	}
	if _, err := Open(nil, State{}, nil); err == nil {
		t.Fatal("expected error for nil reader")
	}
}
