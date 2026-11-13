package dataeng

import "testing"

func TestDeduperUniqueFields(t *testing.T) {
	d := NewDeduper(0)
	a := entry("boot-a", 100, 10, "hello")
	dup := entry("boot-a", 100, 10, "hello")
	dup.Cursor = "different-cursor" // 游标不同但唯一字段集相同
	other := entry("boot-b", 100, 10, "hello")

	if d.Seen(a) {
		t.Fatal("first sight should not be duplicate")
	}
	if !d.Seen(dup) {
		t.Fatal("same unique field set should be duplicate")
	}
	if d.Seen(other) {
		t.Fatal("different boot id should not be duplicate")
	}
}

func TestDeduperCustomFields(t *testing.T) {
	d := NewDeduper(8, "MESSAGE", "_PID")
	a := &Entry{Fields: map[string]string{"MESSAGE": "m", "_PID": "1"}}
	b := &Entry{BootID: "boot-x", Fields: map[string]string{"MESSAGE": "m", "_PID": "1"}}
	c := &Entry{Fields: map[string]string{"MESSAGE": "m", "_PID": "2"}}

	if d.Seen(a) {
		t.Fatal("first sight should not be duplicate")
	}
	if !d.Seen(b) {
		t.Fatal("boot id not in field set, should be duplicate")
	}
	if d.Seen(c) {
		t.Fatal("different pid should not be duplicate")
	}
}

func TestDeduperEviction(t *testing.T) {
	d := NewDeduper(2)
	a := entry("boot-a", 1, 1, "a")
	b := entry("boot-a", 2, 2, "b")
	c := entry("boot-a", 3, 3, "c")

	d.Seen(a)
	d.Seen(b)
	d.Seen(c) // 挤出 a

	if d.Len() != 2 {
		t.Fatalf("window len = %d, want 2", d.Len())
	}
	if d.Seen(a) {
		t.Fatal("evicted key should be forgotten")
	}
	if !d.Seen(c) {
		t.Fatal("c should still be in window")
	}
}
