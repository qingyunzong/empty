package lp1_test

import (
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func TestPrevByteReadBudget(t *testing.T) {
	// Last element is a long string so its reverse field uses several groups,
	// while earlier elements must never be touched by a tail Prev.
	payload := make([]byte, 16379) // u32 prefix (5) + payload => body L = 16384
	for i := range payload {
		payload[i] = byte(i)
	}
	first := fixBuildElement(mustEncode(lp1.Integer(-4096))) // body 2, backlen 1
	second := fixBuildElement(mustEncode(lp1.Integer(4095))) // body 2, backlen 1
	third := fixBuildElement(mustEncode(lp1.String(payload)))
	page := fixBuildPage([]fixElement{first, second, third}, false)
	snap := mustOpen(t, page)
	if snap.ByteReads() != 0 {
		t.Fatalf("Open must not increment counter: %d", snap.ByteReads())
	}

	tail := snap.Tail()
	el, ok := tail.Prev()
	if !ok {
		t.Fatal("tail Prev failed")
	}
	if el.BodyLength != 16384 || el.BacklenSize != 3 {
		t.Fatalf("element shape L=%d backlen=%d", el.BodyLength, el.BacklenSize)
	}
	reads := snap.ByteReads()
	// Exactly the body plus at most five reverse-field bytes, never the rest of
	// the page. Forward body decode reads each body byte once.
	want := uint64(el.BodyLength + el.BacklenSize)
	if reads != want {
		t.Fatalf("Prev reads = %d, want exactly %d (body+backlen)", reads, want)
	}
	pageSize := uint64(len(page))
	if reads >= pageSize {
		t.Fatalf("Prev touched %d of %d page bytes: full-page rescan", reads, pageSize)
	}

	// Next Prev walks only into the previous 3-byte element.
	el2, ok := tail.Prev()
	if !ok || el2.Value.Int() != 4095 {
		t.Fatal("second Prev failed")
	}
	if el2.BodyLength != 2 || el2.BacklenSize != 1 {
		t.Fatalf("second element shape L=%d backlen=%d", el2.BodyLength, el2.BacklenSize)
	}
	reads2 := snap.ByteReads()
	if reads2 != want+uint64(el2.BodyLength+el2.BacklenSize) {
		t.Fatalf("cumulative reads = %d, want %d", reads2,
			want+uint64(el2.BodyLength+el2.BacklenSize))
	}
}

func TestPhysicalRanges(t *testing.T) {
	elems := []fixElement{
		fixBuildElement(mustEncode(lp1.Integer(127))),
		fixBuildElement(mustEncode(lp1.String([]byte{0xff, 0x00}))),
	}
	snap := mustOpen(t, fixBuildPage(elems, false))

	head := snap.Head()
	first, ok := head.Next()
	if !ok {
		t.Fatal("first Next")
	}
	if first.BodyStart != 6 || first.BodyEnd != 7 || first.ElementEnd != 8 {
		t.Fatalf("first range %+v", first)
	}
	second, ok := head.Next()
	if !ok {
		t.Fatal("second Next")
	}
	// 0x82 payload[2] backlen(3)=03: bytes 8..12, element end 12.
	if second.BodyStart != 8 || second.BodyEnd != 11 || second.ElementEnd != 12 {
		t.Fatalf("second range %+v", second)
	}

	tail := snap.Tail()
	b2, ok := tail.Prev()
	if !ok {
		t.Fatal("first Prev")
	}
	if b2.BodyStart != second.BodyStart || b2.ElementEnd != second.ElementEnd {
		t.Fatalf("Prev range %+v vs Next range %+v", b2, second)
	}
	b1, ok := tail.Prev()
	if !ok {
		t.Fatal("second Prev")
	}
	if b1.BodyStart != first.BodyStart || b1.ElementEnd != first.ElementEnd {
		t.Fatalf("Prev first range %+v vs %+v", b1, first)
	}
	if _, ok := tail.Prev(); ok {
		t.Fatal("Prev must exhaust at header")
	}
}

func TestCounterReset(t *testing.T) {
	snap := mustOpen(t, fixBuildPage([]fixElement{
		fixBuildElement(mustEncode(lp1.Integer(1))),
	}, false))
	cur := snap.Head()
	if _, ok := cur.Next(); !ok {
		t.Fatal("Next")
	}
	if snap.ByteReads() == 0 {
		t.Fatal("counter not incremented")
	}
	snap.ResetByteReads()
	if snap.ByteReads() != 0 {
		t.Fatal("reset failed")
	}
}
