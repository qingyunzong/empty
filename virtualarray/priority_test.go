package virtualarray

import (
	"context"
	"testing"
)

// TestLaterMappingShadows builds two overlapping mappings and confirms the
// later one wins and its provenance is reported.
func TestLaterMappingShadows(t *testing.T) {
	vShape := shape(4)
	common := sel(axis(1, 1, 2, 1)) // virtual coords 1,2
	mappings := []Mapping{
		{
			SourceName:  "early",
			SourceShape: shape(4),
			VirtualSel:  common,
			SourceSel:   sel(axis(0, 1, 2, 1)),
		},
		{
			SourceName:  "late",
			SourceShape: shape(4),
			VirtualSel:  common,
			SourceSel:   sel(axis(2, 1, 2, 1)),
		},
	}
	h := newHost()
	h.add("early", COrder, 4)
	h.add("late", COrder, 4)
	va, err := New(vShape, 7, mappings, ordersFor(COrder, "early", "late"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	r := rect([]int64{0}, []int64{4})
	got, err := va.ReadRect(context.Background(), h.snapshot("early", "late"), r, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	for i, p := range got.Points {
		switch i {
		case 1, 2:
			if p.MappingIndex != 1 || p.SourceName != "late" || p.Filled {
				t.Fatalf("point %d not shadowed by late mapping: %+v", i, p)
			}
		default:
			if !p.Filled || p.FillReason != NoMapping {
				t.Fatalf("point %d should be no-mapping fill: %+v", i, p)
			}
		}
	}

	// Values must come from late source coordinates 2 and 3.
	if got.Values[1] != sourceValue(bi(2)) || got.Values[2] != sourceValue(bi(3)) {
		t.Fatalf("shadowed values wrong: %d %d", got.Values[1], got.Values[2])
	}
}

// TestUnavailableSourceNoFallback makes the winning source unavailable and
// asserts fill is returned even though an earlier mapping could cover it.
func TestUnavailableSourceNoFallback(t *testing.T) {
	vShape := shape(3)
	common := sel(axis(0, 1, 3, 1))
	mappings := []Mapping{
		{
			SourceName:  "early",
			SourceShape: shape(3),
			VirtualSel:  common,
			SourceSel:   sel(axis(0, 1, 3, 1)),
		},
		{
			SourceName:  "late",
			SourceShape: shape(3),
			VirtualSel:  common,
			SourceSel:   sel(axis(0, 1, 3, 1)),
		},
	}
	h := newHost()
	h.add("early", COrder, 3)
	h.add("late", COrder, 3)
	va, err := New(vShape, 42, mappings, ordersFor(COrder, "early", "late"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	r := rect([]int64{0}, []int64{3})
	before := h.readCalls
	// Only the early source is available; the winning late source is not.
	got, err := va.ReadRect(context.Background(), h.snapshot("early"), r, nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if h.readCalls != before {
		t.Fatalf("expected no source callback, got %d", h.readCalls-before)
	}
	for i, p := range got.Points {
		if !p.Filled || p.FillReason != SourceUnavailable {
			t.Fatalf("point %d should be source-unavailable fill: %+v", i, p)
		}
		if p.MappingIndex != 1 || p.SourceName != "late" || p.SourceCoord != nil {
			t.Fatalf("point %d provenance wrong: %+v", i, p)
		}
		if got.Values[i] != 42 {
			t.Fatalf("point %d fill = %d, want 42", i, got.Values[i])
		}
	}

	// A wholly unmapped point reports NoMapping instead.
	va2, err := New(shape(5), 42, []Mapping{mappings[0]}, ordersFor(COrder, "early"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got2, err := va2.ReadRect(context.Background(), Snapshot{}, rect([]int64{3}, []int64{5}), nil, h.read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	for i, p := range got2.Points {
		if !p.Filled || p.FillReason != NoMapping {
			t.Fatalf("point %d should be no-mapping: %+v", i, p)
		}
	}
}

// TestFillValueNotTreatedAsMissing stores the fill value inside a source and
// confirms a successful read returns it marked as sourced, not filled.
func TestFillValueNotTreatedAsMissing(t *testing.T) {
	fill := int64(123)
	mappings := []Mapping{{
		SourceName:  "s",
		SourceShape: shape(2),
		VirtualSel:  sel(axis(0, 1, 2, 1)),
		SourceSel:   sel(axis(0, 1, 2, 1)),
	}}
	va, err := New(shape(2), fill, mappings, ordersFor(COrder, "s"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	read := func(_ context.Context, _ string, spans []Span) ([]int64, error) {
		out := []int64{}
		for _, sp := range spans {
			for idx := newBig().Set(sp.Lo); idx.Cmp(sp.Hi) < 0; idx.Add(idx, bigOne()) {
				out = append(out, fill) // source genuinely holds the fill value
			}
		}
		return out, nil
	}
	got, err := va.ReadRect(context.Background(), Snapshot{"s": true},
		rect([]int64{0}, []int64{2}), nil, read)
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	for i, p := range got.Points {
		if p.Filled {
			t.Fatalf("point %d sourced fill value wrongly marked filled", i)
		}
		if got.Values[i] != fill {
			t.Fatalf("point %d value = %d, want %d", i, got.Values[i], fill)
		}
	}
}
