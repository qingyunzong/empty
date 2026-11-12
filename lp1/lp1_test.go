package lp1_test

import (
	"math"
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func mustOpen(t *testing.T, page []byte) *lp1.Snapshot {
	t.Helper()
	snap, err := lp1.Open(page)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return snap
}

func forwardValues(t *testing.T, snap *lp1.Snapshot) []lp1.Value {
	t.Helper()
	var out []lp1.Value
	cur := snap.Head()
	for {
		el, ok := cur.Next()
		if !ok {
			break
		}
		out = append(out, el.Value)
	}
	return out
}

func backwardValues(t *testing.T, snap *lp1.Snapshot) []lp1.Value {
	t.Helper()
	var out []lp1.Value
	cur := snap.Tail()
	for {
		el, ok := cur.Prev()
		if !ok {
			break
		}
		out = append(out, el.Value)
	}
	return out
}

func assertValueSequence(t *testing.T, got []lp1.Value, want []fixValue) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("value count: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if !fixEqual(want[i], got[i]) {
			t.Fatalf("value %d mismatch", i)
		}
	}
}

func reverseFix(in []fixValue) []fixValue {
	out := make([]fixValue, len(in))
	for i := range in {
		out[i] = in[len(in)-1-i]
	}
	return out
}

func bytesOf(n int, fill byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = fill
	}
	return b
}

func TestEmptyPage(t *testing.T) {
	snap := mustOpen(t, lp1.EmptyPage())
	if snap.Count() != 0 || snap.HeaderCount() != 0 {
		t.Fatalf("empty page counts: %d %d", snap.Count(), snap.HeaderCount())
	}
	if _, ok := snap.Head().Next(); ok {
		t.Fatal("empty head Next must be exhausted")
	}
	if _, ok := snap.Tail().Prev(); ok {
		t.Fatal("empty tail Prev must be exhausted")
	}
	if got := snap.ByteReads(); got != 0 {
		t.Fatalf("counter must start at zero, got %d", got)
	}
}

func TestIntegerEndpoints(t *testing.T) {
	cases := []struct {
		n       int64
		first   byte
		bodyLen int
	}{
		{0, 0x00, 1}, {127, 0x7f, 1}, {128, 0xc0, 2}, {-1, 0xdf, 2},
		{-4096, 0xd0, 2}, {4095, 0xcf, 2},
		{-4097, 0xf1, 3}, {4096, 0xf1, 3},
		{32767, 0xf1, 3}, {-32768, 0xf1, 3},
		{32768, 0xf2, 4}, {-32769, 0xf2, 4},
		{8388607, 0xf2, 4}, {-8388608, 0xf2, 4},
		{8388608, 0xf3, 5}, {-8388609, 0xf3, 5},
		{2147483647, 0xf3, 5}, {-2147483648, 0xf3, 5},
		{2147483648, 0xf4, 9},
		{math.MinInt64, 0xf4, 9}, {math.MaxInt64, 0xf4, 9},
	}
	var values []fixValue
	var elems []fixElement
	for _, tc := range cases {
		body, err := lp1.EncodeValue(lp1.Integer(tc.n))
		if err != nil {
			t.Fatalf("encode %d: %v", tc.n, err)
		}
		if len(body) != tc.bodyLen || body[0] != tc.first {
			t.Fatalf("encode %d = % x, want prefix %02x len %d", tc.n, body, tc.first, tc.bodyLen)
		}
		values = append(values, fixInteger(tc.n))
		elems = append(elems, fixBuildElement(body))
	}
	snap := mustOpen(t, fixBuildPage(elems, false))
	assertValueSequence(t, forwardValues(t, snap), values)
	assertValueSequence(t, backwardValues(t, snap), reverseFix(values))

	for _, n := range []int64{-100000, -8388608, -32769} {
		body, _ := lp1.EncodeValue(lp1.Integer(n))
		if body[0] != 0xf2 {
			t.Fatalf("%d expected 24-bit prefix, got %02x", n, body[0])
		}
	}
}
