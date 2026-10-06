package intervaljoin

import (
	"fmt"
	"math/rand"
	"testing"
)

// rowKey is a canonical, comparable form of Row used for multiset comparison.
type rowKey struct {
	key        string
	lts, rts   int64
	lval, rval string
	hasL, hasR bool
}

func keyOf(r Row) rowKey {
	k := rowKey{key: r.Key}
	if r.Left != nil {
		k.hasL = true
		k.lts = r.Left.Ts
		k.lval = fmt.Sprint(r.Left.Val)
	}
	if r.Right != nil {
		k.hasR = true
		k.rts = r.Right.Ts
		k.rval = fmt.Sprint(r.Right.Val)
	}
	return k
}

// apply folds a changelog into a multiset of rows.
func apply(msgs []Msg, acc map[rowKey]int) map[rowKey]int {
	if acc == nil {
		acc = map[rowKey]int{}
	}
	for _, m := range msgs {
		k := keyOf(m.Row)
		switch m.Kind {
		case Insert:
			acc[k]++
		case Retract:
			acc[k]--
			if acc[k] == 0 {
				delete(acc, k)
			}
		}
	}
	return acc
}

// batchJoin is the reference full interval join over complete streams.
func batchJoin(d int64, lefts, rights []Event) map[rowKey]int {
	out := map[rowKey]int{}
	matchedL := make([]bool, len(lefts))
	matchedR := make([]bool, len(rights))
	for i, l := range lefts {
		for j, r := range rights {
			if l.Key == r.Key && absDiff(l.Ts, r.Ts) <= d {
				matchedL[i] = true
				matchedR[j] = true
				lc, rc := l, r
				out[keyOf(Row{Key: l.Key, Left: &lc, Right: &rc})]++
			}
		}
	}
	for i, l := range lefts {
		if !matchedL[i] {
			lc := l
			out[keyOf(Row{Key: l.Key, Left: &lc})]++
		}
	}
	for j, r := range rights {
		if !matchedR[j] {
			rc := r
			out[keyOf(Row{Key: r.Key, Right: &rc})]++
		}
	}
	return out
}

func ev(key string, ts int64) Event {
	return Event{Key: key, Ts: ts, Val: fmt.Sprintf("%s@%d", key, ts)}
}

func TestBoundaryInclusive(t *testing.T) {
	j := New(5)
	var msgs []Msg
	msgs = append(msgs, j.AddLeft(ev("a", 10))...)
	msgs = append(msgs, j.AddRight(ev("a", 15))...) // diff == d: match
	msgs = append(msgs, j.AddRight(ev("a", 5))...)  // diff == d: match
	msgs = append(msgs, j.AddRight(ev("a", 16))...) // diff > d: no match
	msgs = append(msgs, j.AdvanceLeft(1<<62)...)    // flush unmatched right
	got := apply(msgs, nil)
	want := batchJoin(5,
		[]Event{ev("a", 10)},
		[]Event{ev("a", 15), ev("a", 5), ev("a", 16)})
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	pairs := 0
	for _, m := range msgs {
		if m.Kind == Insert && m.Row.Left != nil && m.Row.Right != nil {
			pairs++
		}
	}
	if pairs != 2 {
		t.Fatalf("expected 2 matched pairs at boundary, got %d", pairs)
	}
}

func TestOneToMany(t *testing.T) {
	j := New(3)
	var msgs []Msg
	msgs = append(msgs, j.AddLeft(ev("k", 100))...)
	for _, ts := range []int64{97, 99, 100, 103} {
		msgs = append(msgs, j.AddRight(ev("k", ts))...)
	}
	got := apply(msgs, nil)
	if len(got) != 4 {
		t.Fatalf("expected 4 distinct matched rows, got %d: %v", len(got), got)
	}
	for k := range got {
		if !k.hasL || !k.hasR {
			t.Fatalf("expected only matched rows, got %v", k)
		}
	}
}

func TestUnmatchedWaitsForWatermark(t *testing.T) {
	j := New(5)
	if m := j.AddLeft(ev("a", 10)); len(m) != 0 {
		t.Fatalf("no output expected before watermark, got %v", m)
	}
	// Watermark equal to ts+d is not enough: must strictly exceed it.
	if m := j.AdvanceRight(15); len(m) != 0 {
		t.Fatalf("no output expected at watermark == ts+d, got %v", m)
	}
	m := j.AdvanceRight(16)
	if len(m) != 1 || m[0].Kind != Insert || m[0].Row.Left == nil || m[0].Row.Right != nil {
		t.Fatalf("expected one unmatched left row, got %v", m)
	}
	// Symmetric check for the right side.
	j2 := New(5)
	j2.AddRight(ev("b", 20))
	if m := j2.AdvanceLeft(25); len(m) != 0 {
		t.Fatalf("no output expected at watermark == ts+d, got %v", m)
	}
	m = j2.AdvanceLeft(26)
	if len(m) != 1 || m[0].Row.Right == nil || m[0].Row.Left != nil {
		t.Fatalf("expected one unmatched right row, got %v", m)
	}
}

func TestLateMatchRetractsUnmatched(t *testing.T) {
	j := New(5)
	var all []Msg
	all = append(all, j.AddLeft(ev("a", 10))...)
	all = append(all, j.AdvanceRight(16)...) // emits unmatched left
	// Late right event arrives after the unmatched row was emitted.
	msgs := j.AddRight(ev("a", 12))
	all = append(all, msgs...)
	if len(msgs) != 2 || msgs[0].Kind != Retract || msgs[1].Kind != Insert {
		t.Fatalf("expected retract+insert, got %v", msgs)
	}
	if msgs[0].Row.Left == nil || msgs[0].Row.Right != nil {
		t.Fatalf("retraction must target the unmatched left row, got %v", msgs[0].Row)
	}
	got := apply(all, nil)
	want := batchJoin(5, []Event{ev("a", 10)}, []Event{ev("a", 12)})
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("final state got %v, want %v", got, want)
	}
}

func TestOutOfOrderMatchesBatchJoin(t *testing.T) {
	const d = 7
	rng := rand.New(rand.NewSource(42))
	keys := []string{"x", "y", "z"}
	var lefts, rights []Event
	for i := 0; i < 200; i++ {
		lefts = append(lefts, ev(keys[rng.Intn(len(keys))], int64(rng.Intn(1000))))
	}
	for i := 0; i < 200; i++ {
		rights = append(rights, ev(keys[rng.Intn(len(keys))], int64(rng.Intn(1000))))
	}

	// Interleave both streams in random (out-of-order) arrival order.
	type item struct {
		side Side
		e    Event
	}
	var stream []item
	for _, e := range lefts {
		stream = append(stream, item{Left, e})
	}
	for _, e := range rights {
		stream = append(stream, item{Right, e})
	}
	rng.Shuffle(len(stream), func(i, k int) { stream[i], stream[k] = stream[k], stream[i] })

	j := New(d)
	acc := map[rowKey]int{}
	maxL, maxR := int64(0), int64(0)
	const lateness = 50 // watermarks trail the max seen timestamp
	for _, it := range stream {
		if it.side == Left {
			acc = apply(j.AddLeft(it.e), acc)
			if it.e.Ts > maxL {
				maxL = it.e.Ts
			}
			acc = apply(j.AdvanceLeft(maxL-lateness), acc)
		} else {
			acc = apply(j.AddRight(it.e), acc)
			if it.e.Ts > maxR {
				maxR = it.e.Ts
			}
			acc = apply(j.AdvanceRight(maxR-lateness), acc)
		}
	}
	// Final flush: push both watermarks past every candidate's latest time.
	acc = apply(j.AdvanceLeft(1<<62), acc)
	acc = apply(j.AdvanceRight(1<<62), acc)

	want := batchJoin(d, lefts, rights)
	if len(acc) != len(want) {
		t.Fatalf("row count mismatch: got %d, want %d", len(acc), len(want))
	}
	for k, n := range want {
		if acc[k] != n {
			t.Errorf("row %+v: got count %d, want %d", k, acc[k], n)
		}
	}
	for k := range acc {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected row %+v", k)
		}
	}
}

func TestDeterministicFlushOrder(t *testing.T) {
	j := New(1)
	j.AddLeft(ev("b", 10))
	j.AddLeft(ev("a", 20))
	j.AddLeft(ev("a", 5))
	msgs := j.AdvanceRight(100)
	var got []string
	for _, m := range msgs {
		got = append(got, fmt.Sprintf("%s@%d", m.Row.Key, m.Row.Left.Ts))
	}
	want := []string{"a@5", "a@20", "b@10"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("flush output got %v, want %v", got, want)
	}
}
