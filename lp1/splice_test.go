package lp1_test

import (
	"errors"
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func buildModelPage(t *testing.T, vals []fixValue) ([]byte, []fixElement) {
	t.Helper()
	elems := make([]fixElement, len(vals))
	for i, v := range vals {
		elems[i] = fixBuildElement(mustEncode(v.toValue()))
	}
	return fixBuildPage(elems, false), elems
}

func TestSplicePreservesUntouchedRawBytes(t *testing.T) {
	// Start from a page containing a deliberately wide, non-shortest integer.
	wide, _ := fixEncodeInt(7, 32)
	wideElem := fixBuildElement(wide)
	plain := fixBuildElement(mustEncode(lp1.String([]byte("hello"))))
	page := fixBuildPage([]fixElement{wideElem, plain}, false)
	snap := mustOpen(t, page)

	next, err := snap.Splice(1, 1, []lp1.Value{lp1.Integer(100), lp1.Integer(101)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	model, err := fixDecodePage(next.Bytes())
	if err != nil {
		t.Fatalf("independent decode: %v", err)
	}
	if len(model) != 3 {
		t.Fatalf("model length %d", len(model))
	}
	if string(model[0].raw) != string(wideElem.raw) {
		t.Fatalf("untouched wide element altered: % x", model[0].raw)
	}
	assertValueSequence(t, forwardValues(t, next),
		[]fixValue{fixInteger(7), fixInteger(100), fixInteger(101)})

	// Delete the middle element and confirm both neighbors keep raw bytes.
	next2, err := next.Splice(1, 1, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	model2, _ := fixDecodePage(next2.Bytes())
	if string(model2[0].raw) != string(wideElem.raw) {
		t.Fatal("first element altered after delete")
	}
	last, _ := lp1.EncodeValue(lp1.Integer(101))
	wantLast := fixBuildElement(last)
	if string(model2[1].raw) != string(wantLast.raw) {
		t.Fatal("surviving new element altered after delete")
	}
}

func TestSpliceRangesAndEmptyPage(t *testing.T) {
	empty, err := lp1.Open(lp1.EmptyPage())
	if err != nil {
		t.Fatal(err)
	}
	got, err := empty.Splice(0, 0, []lp1.Value{lp1.Integer(1), lp1.Integer(2)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertValueSequence(t, forwardValues(t, got),
		[]fixValue{fixInteger(1), fixInteger(2)})

	// Append at end is allowed; one past the end is not.
	if _, err := got.Splice(2, 0, []lp1.Value{lp1.Integer(3)}, 0); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := got.Splice(3, 0, nil, 0); !errors.Is(err, lp1.ErrIndexOutOfRange) {
		t.Fatalf("out-of-range start: %v", err)
	}
	if _, err := got.Splice(0, 3, nil, 0); !errors.Is(err, lp1.ErrIndexOutOfRange) {
		t.Fatalf("delete overflow: %v", err)
	}
	if _, err := got.Splice(-1, 0, nil, 0); !errors.Is(err, lp1.ErrIndexOutOfRange) {
		t.Fatalf("negative index: %v", err)
	}

	// Full delete returns an empty page.
	cleared, err := got.Splice(0, 2, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Count() != 0 || len(cleared.Bytes()) != 7 {
		t.Fatalf("cleared page count %d bytes %d", cleared.Count(), len(cleared.Bytes()))
	}
}

func TestSpliceByteBudgetOffByOne(t *testing.T) {
	snap := mustOpen(t, lp1.EmptyPage())
	// Element 0 = single byte integer 1 plus one backlen byte => 2 bytes.
	one, err := snap.Splice(0, 0, []lp1.Value{lp1.Integer(1)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	exact := uint64(len(one.Bytes())) // 7 header/footer + 2
	if exact != 9 {
		t.Fatalf("unexpected page size %d", exact)
	}
	if _, err := snap.Splice(0, 0, []lp1.Value{lp1.Integer(1)}, exact); err != nil {
		t.Fatalf("budget equal to exact size must pass: %v", err)
	}
	if _, err := snap.Splice(0, 0, []lp1.Value{lp1.Integer(1)}, exact-1); !errors.Is(err, lp1.ErrCapacity) {
		t.Fatalf("one-byte short budget: %v", err)
	}

	// A failed splice leaves the old snapshot and its cursors fully usable.
	oldCursor := snap.Tail()
	if _, err := snap.Splice(0, 0,
		[]lp1.Value{lp1.Integer(1), lp1.Integer(2)}, exact); !errors.Is(err, lp1.ErrCapacity) {
		t.Fatalf("expected capacity error: %v", err)
	}
	if _, ok := oldCursor.Prev(); ok {
		t.Fatal("old empty cursor should stay empty")
	}
	if snap.Count() != 0 {
		t.Fatal("old snapshot mutated by failed splice")
	}
}

func TestNoSharedWritableStorage(t *testing.T) {
	payload := []byte{1, 2, 3, 4}
	page, _ := buildModelPage(t, []fixValue{fixString(payload)})
	snap, err := lp1.Open(page)
	if err != nil {
		t.Fatal(err)
	}
	// Mutate caller input after Open.
	page[6] = 0xee
	got := forwardValues(t, snap)
	if got[0].Bytes()[0] != 1 {
		t.Fatal("snapshot shares caller input storage")
	}
	// Mutate a value returned by the cursor; a second traversal must be unaffected.
	cur := snap.Head()
	el, _ := cur.Next()
	el.Value.Bytes()[0] = 0x77
	cur2 := snap.Head()
	el2, _ := cur2.Next()
	if el2.Value.Bytes()[0] != 1 {
		t.Fatal("snapshot shares returned string storage")
	}

	// Mutate caller-owned value bytes after Splice.
	input := []byte{9, 9}
	next, err := snap.Splice(1, 0, []lp1.Value{lp1.String(input)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 0x11
	values := forwardValues(t, next)
	if values[1].Bytes()[0] != 9 {
		t.Fatal("new snapshot shares caller value storage")
	}
	// Snapshot.Bytes must be an independent copy.
	raw := next.Bytes()
	raw[0] ^= 0xff
	if next.Bytes()[0] == raw[0] {
		t.Fatal("Bytes() shares snapshot storage")
	}
}

func TestCursorsBelongToSnapshot(t *testing.T) {
	snap := mustOpen(t, lp1.EmptyPage())
	next, err := snap.Splice(0, 0, []lp1.Value{lp1.Integer(1), lp1.Integer(2)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Old cursor still describes the old empty snapshot; new cursor is independent.
	oldCur := snap.Head()
	if _, ok := oldCur.Next(); ok {
		t.Fatal("old cursor saw splice result")
	}
	newCur := next.Head()
	el, ok := newCur.Next()
	if !ok || el.Value.Int() != 1 {
		t.Fatal("new cursor failed on new snapshot")
	}
}
