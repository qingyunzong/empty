package dataeng

import (
	"fmt"
	"testing"
)

func referenceIntervals(d Domain, r Rect) []Interval {
	words := make([]uint64, (d.CodeCount()+63)/64)
	for y := r.MinY; y <= r.MaxY; y++ {
		for x := r.MinX; x <= r.MaxX; x++ {
			code := interleave(x, y, d.Bits)
			words[code>>6] |= uint64(1) << (code & 63)
		}
	}
	var out []Interval
	for code := uint32(0); code < d.CodeCount(); code++ {
		if words[code>>6]&(uint64(1)<<(code&63)) == 0 {
			continue
		}
		if len(out) > 0 && out[len(out)-1].Hi == code {
			out[len(out)-1].Hi = code + 1
			continue
		}
		out = append(out, Interval{Lo: code, Hi: code + 1})
	}
	return out
}

func sameRanges(a, b []Interval) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Lo != b[i].Lo || a[i].Hi != b[i].Hi {
			return false
		}
	}
	return true
}

func TestPointwiseExhaustiveB1ToB5(t *testing.T) {
	for bits := 1; bits <= 5; bits++ {
		bits := bits
		t.Run(fmt.Sprintf("b=%d", bits), func(t *testing.T) {
			d := mustDomain(t, bits)
			size := int(d.Size())
			budget := int(d.CodeCount())
			checked := 0
			for x0 := 0; x0 < size; x0++ {
				for x1 := x0; x1 < size; x1++ {
					for y0 := 0; y0 < size; y0++ {
						for y1 := y0; y1 < size; y1++ {
							r := Rect{
								MinX: uint32(x0), MaxX: uint32(x1),
								MinY: uint32(y0), MaxY: uint32(y1),
							}
							got, err := d.Query(r, budget)
							if err != nil {
								t.Fatalf("b=%d Query(%+v): %v", bits, r, err)
							}
							want := referenceIntervals(d, r)
							if !sameRanges(got.Intervals, want) {
								t.Fatalf("b=%d rect %+v:\n got %v\nwant %v",
									bits, r, ranges(got.Intervals), ranges(want))
							}
							if !got.Complete || len(got.Pending) != 0 {
								t.Fatalf("b=%d rect %+v not complete: %+v", bits, r, got)
							}
							// Verification is exact-range work of its own; for the
							// exhaustive b=5 sweep, run it on a deterministic sample
							// while still comparing every result to the bit reference.
							if bits <= 4 || checked%97 == 0 {
								if err := d.Verify(r, got); err != nil {
									t.Fatalf("b=%d rect %+v Verify: %v", bits, r, err)
								}
							}
							checked++
						}
					}
				}
			}
			wantChecked := size * (size + 1) / 2
			wantChecked *= wantChecked
			if checked != wantChecked {
				t.Fatalf("b=%d checked %d rectangles, want %d", bits, checked, wantChecked)
			}
		})
	}
}

func ranges(ivs []Interval) string {
	out := "["
	for i, iv := range ivs {
		if i > 0 {
			out += " "
		}
		out += fmt.Sprintf("[%d,%d)", iv.Lo, iv.Hi)
	}
	return out + "]"
}

func TestQuadtreePrefixDigitsAndChildren(t *testing.T) {
	d := mustDomain(t, 2)
	root, err := d.RootNode()
	if err != nil {
		t.Fatal(err)
	}
	n1, err := d.ChildNode(root, 1) // x=1, y=0 quadrant
	if err != nil {
		t.Fatal(err)
	}
	n12, err := d.ChildNode(n1, 2) // then x=0, y=1
	if err != nil {
		t.Fatal(err)
	}
	digits, ok := n12.Digits()
	if !ok || len(digits) != 2 || digits[0] != 1 || digits[1] != 2 {
		t.Fatalf("digits = %v, ok=%v; want [1 2]", digits, ok)
	}
	lo, hi, ok := n12.CodeRange()
	if !ok || lo != 6 || hi != 7 {
		t.Fatalf("range = [%d,%d), ok=%v; want [6,7)", lo, hi, ok)
	}
	rect, ok := n12.CellRect()
	if !ok || rect != (Rect{MinX: 2, MinY: 1, MaxX: 2, MaxY: 1}) {
		t.Fatalf("rect = %+v, ok=%v; want (2,1)-(2,1)", rect, ok)
	}

	bad := Node{Bits: 2, Depth: 1, Prefix: 1} // low prefix bits must be zero
	if bad.Valid() {
		t.Fatal("Node with dirty low prefix bits reported valid")
	}
	bad = Node{Bits: 2, Depth: 3, Prefix: 0}
	if bad.Valid() {
		t.Fatal("Node below leaf reported valid")
	}
}

func TestDegenerateRowsAndColumnsB5(t *testing.T) {
	d := mustDomain(t, 5)
	size := int(d.Size())
	for y := 0; y < size; y++ {
		r := Rect{MinX: 0, MinY: uint32(y), MaxX: uint32(size - 1), MaxY: uint32(y)}
		res, err := d.Query(r, int(d.CodeCount()))
		if err != nil {
			t.Fatal(err)
		}
		want := referenceIntervals(d, r)
		if !sameRanges(res.Intervals, want) {
			t.Fatalf("row y=%d: got %s want %s", y, ranges(res.Intervals), ranges(want))
		}
		if err := d.Verify(r, res); err != nil {
			t.Fatalf("row y=%d Verify: %v", y, err)
		}
	}
	for x := 0; x < size; x++ {
		r := Rect{MinX: uint32(x), MinY: 0, MaxX: uint32(x), MaxY: uint32(size - 1)}
		res, err := d.Query(r, int(d.CodeCount()))
		if err != nil {
			t.Fatal(err)
		}
		want := referenceIntervals(d, r)
		if !sameRanges(res.Intervals, want) {
			t.Fatalf("column x=%d: got %s want %s", x, ranges(res.Intervals), ranges(want))
		}
		if err := d.Verify(r, res); err != nil {
			t.Fatalf("column x=%d Verify: %v", x, err)
		}
	}
}

func TestCrossQuadtreeBoundariesB5(t *testing.T) {
	d := mustDomain(t, 5)
	cases := []Rect{
		{MinX: 15, MaxX: 16, MinY: 0, MaxY: 31},
		{MinX: 0, MaxX: 31, MinY: 15, MaxY: 16},
		{MinX: 15, MaxX: 16, MinY: 15, MaxY: 16},
		{MinX: 7, MaxX: 24, MinY: 7, MaxY: 24},
		{MinX: 0, MaxX: 15, MinY: 0, MaxY: 15},
		{MinX: 1, MaxX: 16, MinY: 1, MaxY: 16},
		{MinX: 0, MaxX: 31, MinY: 0, MaxY: 1},
	}
	for _, r := range cases {
		res, err := d.Query(r, int(d.CodeCount()))
		if err != nil {
			t.Fatalf("%+v: %v", r, err)
		}
		want := referenceIntervals(d, r)
		if !sameRanges(res.Intervals, want) {
			t.Fatalf("%+v: got %s want %s", r, ranges(res.Intervals), ranges(want))
		}
		if err := d.Verify(r, res); err != nil {
			t.Fatalf("%+v Verify: %v", r, err)
		}
	}
}

func TestAdjacentNodesMergeIntoNonNodeInterval(t *testing.T) {
	d := mustDomain(t, 2)
	r := Rect{MinX: 0, MaxX: 3, MinY: 0, MaxY: 1}
	res, err := d.Query(r, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || len(res.Intervals) != 1 {
		t.Fatalf("result = %+v, want one complete interval", res)
	}
	iv := res.Intervals[0]
	if iv.Lo != 0 || iv.Hi != 8 {
		t.Fatalf("interval = [%d,%d), want [0,8)", iv.Lo, iv.Hi)
	}
	if len(iv.Prefixes) != 2 {
		t.Fatalf("interval has %d prefixes, want 2", len(iv.Prefixes))
	}
	if err := d.Verify(r, res); err != nil {
		t.Fatal(err)
	}
}

func codeInIntervals(code uint32, ivs []Interval) bool {
	for _, iv := range ivs {
		if code >= iv.Lo && code < iv.Hi {
			return true
		}
	}
	return false
}

func codeInNodes(code uint32, nodes []Node) bool {
	for _, n := range nodes {
		lo, hi, ok := n.CodeRange()
		if ok && code >= lo && code < hi {
			return true
		}
	}
	return false
}

func checkPartition(t *testing.T, d Domain, r Rect, res Result) {
	t.Helper()
	for code := uint32(0); code < d.CodeCount(); code++ {
		inRect := d.ContainsCode(r, code)
		inDone := codeInIntervals(code, res.Intervals)
		inPending := codeInNodes(code, res.Pending)
		if inRect && inDone == inPending {
			t.Fatalf("code %d in rect=%v done=%v pending=%v; need exactly one",
				code, inRect, inDone, inPending)
		}
		if !inRect && (inDone || inPending) {
			t.Fatalf("code %d outside rect but covered (done=%v pending=%v)",
				code, inDone, inPending)
		}
	}
}

func TestBudgetPartialIsExactMortonPrefix(t *testing.T) {
	cases := []struct {
		bits int
		r    Rect
	}{
		{1, Rect{MinX: 0, MaxX: 1, MinY: 0, MaxY: 0}},
		{2, Rect{MinX: 1, MaxX: 2, MinY: 0, MaxY: 2}},
		{3, Rect{MinX: 0, MaxX: 7, MinY: 3, MaxY: 3}},
		{3, Rect{MinX: 2, MaxX: 6, MinY: 2, MaxY: 6}},
		{4, Rect{MinX: 0, MaxX: 15, MinY: 0, MaxY: 15}},
		{4, Rect{MinX: 7, MaxX: 8, MinY: 0, MaxY: 15}},
		{5, Rect{MinX: 0, MaxX: 31, MinY: 9, MaxY: 22}},
		{5, Rect{MinX: 5, MaxX: 20, MinY: 5, MaxY: 20}},
	}
	for _, tc := range cases {
		d := mustDomain(t, tc.bits)
		full, err := d.Query(tc.r, int(d.CodeCount()))
		if err != nil {
			t.Fatalf("b=%d %+v: %v", tc.bits, tc.r, err)
		}
		total := len(full.Intervals)
		for budget := 0; budget <= total+1; budget++ {
			res, err := d.Query(tc.r, budget)
			if err != nil {
				t.Fatalf("b=%d %+v budget=%d: %v", tc.bits, tc.r, budget, err)
			}
			if budget >= total {
				if !res.Complete || len(res.Pending) != 0 {
					t.Fatalf("b=%d %+v budget=%d(total=%d) not complete: %+v",
						tc.bits, tc.r, budget, total, res)
				}
				if !sameRanges(res.Intervals, full.Intervals) {
					t.Fatalf("b=%d %+v budget=%d intervals differ from full", tc.bits, tc.r, budget)
				}
			} else {
				if res.Complete {
					t.Fatalf("b=%d %+v budget=%d(total=%d) finished", tc.bits, tc.r, budget, total)
				}
				if len(res.Intervals) != budget {
					t.Fatalf("b=%d %+v budget=%d: got %d intervals",
						tc.bits, tc.r, budget, len(res.Intervals))
				}
				if !sameRanges(res.Intervals, full.Intervals[:budget]) {
					t.Fatalf("b=%d %+v budget=%d: confirmed interval prefix mismatch",
						tc.bits, tc.r, budget)
				}
				if len(res.Pending) == 0 {
					t.Fatalf("b=%d %+v budget=%d: no pending prefixes", tc.bits, tc.r, budget)
				}
				wantPending := 0
				for i := 0; i < budget; i++ {
					wantPending += len(full.Intervals[i].Prefixes)
				}
				nodes := d.collectNodes(tc.r)
				if len(res.Pending) != len(nodes)-wantPending {
					t.Fatalf("b=%d %+v budget=%d: pending count %d, want %d",
						tc.bits, tc.r, budget, len(res.Pending), len(nodes)-wantPending)
				}
			}
			if err := d.Verify(tc.r, res); err != nil {
				t.Fatalf("b=%d %+v budget=%d Verify: %v", tc.bits, tc.r, budget, err)
			}
			checkPartition(t, d, tc.r, res)
		}
	}
}

func TestBudgetCountsIntervalsNotPrefixes(t *testing.T) {
	d := mustDomain(t, 1)
	r := Rect{MinX: 0, MaxX: 1, MinY: 0, MaxY: 0}
	res, err := d.Query(r, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || len(res.Intervals) != 1 || len(res.Intervals[0].Prefixes) != 2 {
		t.Fatalf("result = %+v; budget 1 should accept one interval with two prefixes", res)
	}
}

func TestB12FullDomainAndSmallQueries(t *testing.T) {
	d := mustDomain(t, 12)
	size := int(d.Size())
	full := Rect{MinX: 0, MaxX: uint32(size - 1), MinY: 0, MaxY: uint32(size - 1)}
	res, err := d.Query(full, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || len(res.Intervals) != 1 {
		t.Fatalf("full domain = %+v, want one complete interval", res)
	}
	iv := res.Intervals[0]
	if iv.Lo != 0 || iv.Hi != d.CodeCount() || len(iv.Prefixes) != 1 {
		t.Fatalf("full interval = [%d,%d) with %d prefixes", iv.Lo, iv.Hi, len(iv.Prefixes))
	}
	if n := iv.Prefixes[0]; n.Depth != 0 || n.Prefix != 0 {
		t.Fatalf("full prefix = %+v, want root", n)
	}
	if err := d.Verify(full, res); err != nil {
		t.Fatal(err)
	}

	resZero, err := d.Query(full, 0)
	if err != nil {
		t.Fatal(err)
	}
	if resZero.Complete || len(resZero.Intervals) != 0 || len(resZero.Pending) != 1 {
		t.Fatalf("full domain budget 0 = %+v", resZero)
	}
	if err := d.Verify(full, resZero); err != nil {
		t.Fatal(err)
	}

	cell := Rect{MinX: 1234, MaxX: 1234, MinY: 3210, MaxY: 3210}
	res, err = d.Query(cell, 1)
	if err != nil {
		t.Fatal(err)
	}
	code, _ := d.Encode(1234, 3210)
	if !res.Complete || len(res.Intervals) != 1 ||
		res.Intervals[0].Lo != code || res.Intervals[0].Hi != code+1 {
		t.Fatalf("cell result = %+v, want [%d,%d)", res, code, code+1)
	}
	if err := d.Verify(cell, res); err != nil {
		t.Fatal(err)
	}

	if nodes := d.collectNodes(full); len(nodes) != 1 {
		t.Fatalf("full domain collected %d nodes", len(nodes))
	}
	if nodes := d.collectNodes(cell); len(nodes) != 1 {
		t.Fatalf("single cell collected %d nodes", len(nodes))
	}
}

func TestB12ThinRowAndBudget(t *testing.T) {
	d := mustDomain(t, 12)
	size := uint32(d.Size())
	r := Rect{MinX: 0, MaxX: size - 1, MinY: 0, MaxY: 0}
	full, err := d.Query(r, int(d.CodeCount()))
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Intervals) != 1<<(d.Bits-1) {
		t.Fatalf("row intervals = %d, want %d", len(full.Intervals), 1<<(d.Bits-1))
	}
	if err := d.Verify(r, full); err != nil {
		t.Fatal(err)
	}
	partial, err := d.Query(r, 3)
	if err != nil {
		t.Fatal(err)
	}
	if partial.Complete || len(partial.Intervals) != 3 || len(partial.Pending) == 0 {
		t.Fatalf("budget 3 result = %+v", partial)
	}
	if err := d.Verify(r, partial); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRejectsBrokenResults(t *testing.T) {
	d := mustDomain(t, 2)
	r := Rect{MinX: 0, MaxX: 3, MinY: 0, MaxY: 1}
	good, err := d.Query(r, int(d.CodeCount()))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Verify(r, good); err != nil {
		t.Fatalf("good result rejected: %v", err)
	}

	overlap := Result{
		Complete: true,
		Intervals: []Interval{
			good.Intervals[0],
			{Lo: 1, Hi: 2, Prefixes: []Node{{Bits: 2, Depth: 2, Prefix: 1}}},
		},
	}
	if err := d.Verify(r, overlap); err == nil {
		t.Fatal("overlapping intervals accepted")
	}

	outside := Result{
		Complete: true,
		Intervals: []Interval{{
			Lo:       8,
			Hi:       9,
			Prefixes: []Node{{Bits: 2, Depth: 2, Prefix: 8}},
		}},
		Pending: []Node{{Bits: 2, Depth: 0, Prefix: 0}},
	}
	if err := d.Verify(r, outside); err == nil {
		t.Fatal("complete result with pending accepted")
	}

	tooBroad := Result{Complete: false, Intervals: nil,
		Pending: []Node{{Bits: 2, Depth: 0, Prefix: 0}}}
	if err := d.Verify(r, tooBroad); err == nil {
		t.Fatal("pending root outside the query accepted")
	}

	// Use a query with two code runs so removing one leaves a real gap.
	gapRect := Rect{MinX: 0, MaxX: 1, MinY: 0, MaxY: 3}
	withGap, err := d.Query(gapRect, int(d.CodeCount()))
	if err != nil {
		t.Fatal(err)
	}
	if len(withGap.Intervals) < 2 {
		t.Fatalf("test setup: gap query has %d intervals", len(withGap.Intervals))
	}
	missing := Result{Complete: true, Intervals: []Interval{withGap.Intervals[0]}}
	if err := d.Verify(gapRect, missing); err == nil {
		t.Fatal("result with an uncovered query gap accepted")
	}
}
