package virtualarray

import (
	"context"
	"math/big"
	"testing"
)

// TestDedupeAndMerge verifies identical positions are read once and adjacent
// positions are coalesced into one half-open span.
func TestDedupeAndMerge(t *testing.T) {
	positions := []*big.Int{
		bi(5), bi(5), bi(6), bi(7), // 5,6,7 adjacent -> [5,8)
		bi(10), bi(12), bi(11), // 10,11,12 adjacent -> [10,13)
		bi(20), // isolated -> [20,21)
		bi(7),  // duplicate
	}
	uniq := dedupeAndSort(positions)
	wantUniq := []int64{5, 6, 7, 10, 11, 12, 20}
	if len(uniq) != len(wantUniq) {
		t.Fatalf("uniq len = %d, want %d", len(uniq), len(wantUniq))
	}
	for i, w := range wantUniq {
		if uniq[i].Int64() != w {
			t.Fatalf("uniq[%d] = %d, want %d", i, uniq[i], w)
		}
	}

	spans := mergeAdjacent(uniq)
	wantSpans := []Span{
		{Lo: bi(5), Hi: bi(8)},
		{Lo: bi(10), Hi: bi(13)},
		{Lo: bi(20), Hi: bi(21)},
	}
	if len(spans) != len(wantSpans) {
		t.Fatalf("spans len = %d, want %d", len(spans), len(wantSpans))
	}
	for i, sp := range wantSpans {
		if spans[i].Lo.Cmp(sp.Lo) != 0 || spans[i].Hi.Cmp(sp.Hi) != 0 {
			t.Fatalf("span[%d] = [%s,%s), want [%s,%s)",
				i, spans[i].Lo, spans[i].Hi, sp.Lo, sp.Hi)
		}
	}
}

// TestDuplicateSourcePositionReadOnce arranges several virtual points onto
// the same source position and asserts a single merged read and correct
// fan-out to every output point.
func TestDuplicateSourcePositionReadOnce(t *testing.T) {
	// Three distinct virtual points map to source coordinate 0.
	mappings := []Mapping{
		{
			SourceName:  "s",
			SourceShape: shape(4),
			VirtualSel:  sel(axis(0, 1, 1, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1)),
		},
		{
			SourceName:  "s",
			SourceShape: shape(4),
			VirtualSel:  sel(axis(2, 1, 1, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1)),
		},
		{
			SourceName:  "s",
			SourceShape: shape(4),
			VirtualSel:  sel(axis(3, 1, 1, 1)),
			SourceSel:   sel(axis(0, 1, 1, 1)),
		},
	}
	h := newHost()
	h.add("s", COrder, 4)
	va, err := New(shape(4), -1, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect([]int64{0}, []int64{4}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if h.readCalls != 1 {
		t.Fatalf("read calls = %d, want 1", h.readCalls)
	}
	if len(h.lastSpans["s"]) != 1 {
		t.Fatalf("spans = %v, want one merged span", h.lastSpans["s"])
	}
	sp := h.lastSpans["s"][0]
	if sp.Lo.Int64() != 0 || sp.Hi.Int64() != 1 {
		t.Fatalf("span = [%s,%s), want [0,1)", sp.Lo, sp.Hi)
	}
	for _, idx := range []int{0, 2, 3} {
		if got.Values[idx] != sourceValue(bi(0)) {
			t.Fatalf("value[%d] = %d, want shared source value", idx, got.Values[idx])
		}
		if got.Points[idx].Filled {
			t.Fatalf("point %d should be sourced", idx)
		}
	}
	if !got.Points[1].Filled {
		t.Fatalf("point 1 has no mapping and should be filled")
	}
}

// TestReadFailureDeliversNothing ensures a callback error fails the whole
// read and no partial result is returned.
// TestPerSourceCallbacks confirms distinct sources get independent batched
// callbacks while an unavailable source gets none at all.
func TestPerSourceCallbacks(t *testing.T) {
	mappings := []Mapping{
		{
			SourceName:  "a",
			SourceShape: shape(4),
			VirtualSel:  sel(axis(0, 1, 2, 1)), // virtual 0,1
			SourceSel:   sel(axis(0, 1, 2, 1)),
		},
		{
			SourceName:  "b",
			SourceShape: shape(4),
			VirtualSel:  sel(axis(2, 1, 2, 1)), // virtual 2,3
			SourceSel:   sel(axis(0, 1, 2, 1)),
		},
	}
	h := newHost()
	h.add("a", COrder, 4)
	h.add("b", COrder, 4)
	va, err := New(shape(4), 0, mappings, ordersFor(COrder, "a", "b"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Source "b" is unavailable: only "a" is read.
	got, err := va.ReadRect(context.Background(), h.snapshot("a"),
		rect([]int64{0}, []int64{4}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if h.readCalls != 1 {
		t.Fatalf("read calls = %d, want 1", h.readCalls)
	}
	if _, ok := h.lastSpans["a"]; !ok {
		t.Fatalf("expected a span batch for source a, got %v", h.lastSpans)
	}
	if _, ok := h.lastSpans["b"]; ok {
		t.Fatalf("unavailable source b must not be read")
	}
	if !got.Points[2].Filled || got.Points[2].FillReason != SourceUnavailable {
		t.Fatalf("point 2 should be source-unavailable: %+v", got.Points[2])
	}

	// With both available, each source is read exactly once.
	h.readCalls = 0
	h.lastSpans = map[string][]Span{}
	got2, err := va.ReadRect(context.Background(), h.snapshot("a", "b"),
		rect([]int64{0}, []int64{4}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if h.readCalls != 2 {
		t.Fatalf("read calls = %d, want 2", h.readCalls)
	}
	for _, p := range got2.Points {
		if p.Filled {
			t.Fatalf("no fill expected with both sources available")
		}
	}
}

func TestReadFailureDeliversNothing(t *testing.T) {
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(3),
		VirtualSel:  sel(axis(0, 1, 3, 1)),
		SourceSel:   sel(axis(0, 1, 3, 1)),
	}}
	h := newHost()
	h.add("s", COrder, 3)
	va, err := New(shape(3), 0, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h.failNext = true
	got, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect([]int64{0}, []int64{3}), nil, h.read)
	if err == nil {
		t.Fatalf("expected read error, got result %v", got)
	}

	// A short batch is also a hard read failure.
	h.wrongLength = true
	if _, err := va.ReadRect(context.Background(), h.snapshot("s"),
		rect([]int64{0}, []int64{3}), nil, h.read); err == nil {
		t.Fatalf("expected short-batch error")
	}
}
