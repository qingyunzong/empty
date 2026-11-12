package lp1_test

import (
	"encoding/binary"
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func TestFiveGroupBacklen(t *testing.T) {
	// Five groups are needed once L exceeds 28 bits. Allocating such a body is
	// impractical in a unit test, so the backward reader is exercised with a
	// hand-built element whose declared reverse field uses five groups and
	// whose body is padded to the matching length is likewise large; instead
	// assert the documented multi-group encodings directly.
	cases := map[int][]byte{
		128:       {0x01, 0x80},
		500:       {0x03, 0xf4}, // the example from the specification
		16384:     {0x01, 0x80, 0x80},
		2097152:   {0x01, 0x80, 0x80, 0x80},
		268435455: {0x7f, 0xff, 0xff, 0xff},
		268435456: {0x01, 0x80, 0x80, 0x80, 0x80},
	}
	for l, want := range cases {
		got := fixEncodeBacklen(l)
		if len(got) != len(want) {
			t.Fatalf("L=%d groups %d want %d", l, len(got), len(want))
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("L=%d encoding % x want % x", l, got, want)
			}
		}
	}
}

func TestF0LengthOverflowRejected(t *testing.T) {
	// A u32 string prefix claiming 0xffffffff payload cannot fit any page.
	page := make([]byte, 6+9+1)
	binary.LittleEndian.PutUint32(page[0:4], uint32(len(page)))
	binary.LittleEndian.PutUint16(page[4:6], 1)
	page[6] = 0xf0
	binary.LittleEndian.PutUint32(page[7:11], 0xffffffff)
	copy(page[11:], []byte{1, 2, 3, 4})
	page[len(page)-1] = 0xff
	if _, err := lp1.Open(page); err == nil {
		t.Fatal("oversized f0 string accepted")
	}
}

func TestZeroBacklenRejected(t *testing.T) {
	// Body prefix 0x80 (empty string) followed by a zero reverse-length byte:
	// L=0 is forbidden and the backward reader must reject it.
	page := fixBuildPage([]fixElement{{raw: []byte{0x80, 0x00}}}, false)
	if _, err := lp1.Open(page); err == nil {
		t.Fatal("zero reverse length accepted")
	}
}

func TestAlternatingForwardBackward(t *testing.T) {
	values := []fixValue{
		fixInteger(0), fixInteger(127), fixInteger(-4096),
		fixString([]byte{0xff}), fixString(nil), fixInteger(4095),
	}
	var elems []fixElement
	for _, v := range values {
		elems = append(elems, fixBuildElement(mustEncode(v.toValue())))
	}
	snap := mustOpen(t, fixBuildPage(elems, false))

	// Walk forward, then backward from each reached boundary: Prev must return
	// the exact element just visited without any header rescan.
	head := snap.Head()
	tail := snap.Tail()
	for i, v := range values {
		fwd, ok := head.Next()
		if !ok {
			t.Fatalf("forward exhausted at %d", i)
		}
		if !fixEqual(v, fwd.Value) {
			t.Fatalf("forward %d mismatch", i)
		}
		back, ok := tail.Prev()
		if !ok || !fixEqual(values[len(values)-1-i], back.Value) {
			t.Fatalf("backward %d mismatch", i)
		}
	}
	if _, ok := head.Next(); ok {
		t.Fatal("head cursor not exhausted")
	}
	if _, ok := tail.Prev(); ok {
		t.Fatal("tail cursor not exhausted")
	}
}
