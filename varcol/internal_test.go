package varcol

import (
	"testing"
	"unsafe"
)

func TestSliceSharesCoreAndRefs(t *testing.T) {
	data := []byte("abcdef")
	offsets := []int32{0, 1, 3, 6}
	col, err := New(data, offsets, nil, 3, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := col.refs(); got != 1 {
		t.Fatalf("initial refs = %d, want 1", got)
	}

	s1, err := col.Slice(0, 2)
	if err != nil {
		t.Fatalf("Slice: %v", err)
	}
	s2, err := col.Slice(1, 3)
	if err != nil {
		t.Fatalf("Slice: %v", err)
	}

	if s1.core != col.core || s2.core != col.core {
		t.Fatal("slices must share the same core (zero-copy)")
	}
	if got := col.refs(); got != 3 {
		t.Fatalf("refs after two slices = %d, want 3", got)
	}
	if s1.start != 0 || s1.end != 2 || s2.start != 1 || s2.end != 3 {
		t.Fatalf("slice windows wrong: s1=[%d,%d) s2=[%d,%d)", s1.start, s1.end, s2.start, s2.end)
	}

	if err := s1.Release(); err != nil {
		t.Fatalf("Release s1: %v", err)
	}
	if got := col.refs(); got != 2 {
		t.Fatalf("refs after releasing s1 = %d, want 2", got)
	}
	if err := s2.Release(); err != nil {
		t.Fatalf("Release s2: %v", err)
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release col: %v", err)
	}
}

func TestRecyclerReceivesOriginalBuffersOnce(t *testing.T) {
	data := []byte("abcdef")
	offsets := []int32{0, 1, 3, 6}
	validity := []byte{0x07}

	calls := 0
	recycle := func(d []byte, o []int32, v []byte) {
		calls++
		if unsafe.SliceData(d) != unsafe.SliceData(data) {
			t.Error("recycler data is not the original buffer")
		}
		if unsafe.SliceData(o) != unsafe.SliceData(offsets) {
			t.Error("recycler offsets is not the original slice")
		}
		if unsafe.SliceData(v) != unsafe.SliceData(validity) {
			t.Error("recycler validity is not the original slice")
		}
	}

	col, err := New(data, offsets, validity, 3, recycle)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s, err := col.Slice(0, 3)
	if err != nil {
		t.Fatalf("Slice: %v", err)
	}

	if err := col.Release(); err != nil {
		t.Fatalf("Release col: %v", err)
	}
	if calls != 0 {
		t.Fatalf("recycler called %d times while a holder remains", calls)
	}
	if err := s.Release(); err != nil {
		t.Fatalf("Release slice: %v", err)
	}
	if calls != 1 {
		t.Fatalf("recycler called %d times, want exactly 1", calls)
	}
}

func TestConcatSkipsNullPhysicalRange(t *testing.T) {
	// 行布局：row0="abc" 有效；row1=null 但占用 "WXYZ"；row2="yz" 有效。
	data := []byte("abcWXYZyz")
	offsets := []int32{0, 3, 7, 9}
	validity := []byte{0x05} // bit0、bit2 置位

	var recycled []byte
	col, err := New(data, offsets, validity, 3, func(d []byte, _ []int32, _ []byte) {
		recycled = d
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	merged, err := Concat([]*Column{col}, func(d []byte, _ []int32, _ []byte) {
		recycled = d
	})
	if err != nil {
		t.Fatalf("Concat: %v", err)
	}

	if got := merged.end - merged.start; got != 3 {
		t.Fatalf("merged rows = %d, want 3", got)
	}
	wantOffsets := []int32{0, 3, 3, 5}
	for i, want := range wantOffsets {
		if merged.core.offsets[i] != want {
			t.Fatalf("merged offset[%d] = %d, want %d", i, merged.core.offsets[i], want)
		}
	}
	if got := string(merged.core.data); got != "abcyz" {
		t.Fatalf("merged data = %q, want %q (null physical range skipped)", got, "abcyz")
	}
	if merged.core == col.core {
		t.Fatal("concat output must not share the input core")
	}

	if err := merged.Release(); err != nil {
		t.Fatalf("Release merged: %v", err)
	}
	if string(recycled) != "abcyz" {
		t.Fatalf("recycled merged data = %q, want %q", string(recycled), "abcyz")
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release col: %v", err)
	}
}
