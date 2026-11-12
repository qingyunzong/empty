package lp1_test

import (
	"encoding/binary"
	"errors"
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func singlePage(body []byte) []byte {
	return fixBuildPage([]fixElement{fixBuildElement(body)}, false)
}

func TestUnknownHeaderCount(t *testing.T) {
	values := []fixValue{fixInteger(1), fixInteger(2), fixInteger(3)}
	var elems []fixElement
	for _, v := range values {
		elems = append(elems, fixBuildElement(mustEncode(v.toValue())))
	}
	snap := mustOpen(t, fixBuildPage(elems, true))
	if snap.HeaderCount() != 65535 || snap.Count() != 3 {
		t.Fatalf("unknown count header: %d real %d", snap.HeaderCount(), snap.Count())
	}
	assertValueSequence(t, forwardValues(t, snap), values)

	next, err := snap.Splice(1, 0, []lp1.Value{lp1.Integer(7)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if next.HeaderCount() != 4 || next.Count() != 4 {
		t.Fatalf("rebuilt header count: %d real %d", next.HeaderCount(), next.Count())
	}
}

func TestHeaderCountOverflow(t *testing.T) {
	base, err := lp1.Open(lp1.EmptyPage())
	if err != nil {
		t.Fatal(err)
	}
	vals := make([]lp1.Value, 65535)
	for i := range vals {
		vals[i] = lp1.Integer(int64(i % 128))
	}
	snap, err := base.Splice(0, 0, vals, 0)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Count() != 65535 || snap.HeaderCount() != 65535 {
		t.Fatalf("at 65535: real %d header %d", snap.Count(), snap.HeaderCount())
	}
	snap2, err := snap.Splice(65535, 0, []lp1.Value{lp1.Integer(1)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if snap2.Count() != 65536 || snap2.HeaderCount() != 65535 {
		t.Fatalf("at 65536: real %d header %d", snap2.Count(), snap2.HeaderCount())
	}
	old := snap.Tail()
	el, ok := old.Prev()
	if !ok || el.Value.Int() != 126 {
		t.Fatal("old cursor invalidated by splice")
	}
}

func TestMalformedPages(t *testing.T) {
	good := singlePage(mustEncode(lp1.Integer(42)))

	extra := append(append([]byte(nil), good...), 0x00)
	assertMalformed(t, extra, "extra trailing byte")

	trunc := append([]byte(nil), good[:len(good)-2]...)
	assertMalformed(t, trunc, "truncated page")

	badTotal := append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(badTotal[0:4], uint32(len(badTotal)+1))
	assertMalformed(t, badTotal, "header total mismatch")

	badFooter := append([]byte(nil), good...)
	badFooter[len(badFooter)-1] = 0x00
	assertMalformed(t, badFooter, "wrong footer")

	badCount := append([]byte(nil), good...)
	binary.LittleEndian.PutUint16(badCount[4:6], 2)
	assertMalformed(t, badCount, "wrong element count")

	short := []byte{0x07, 0x00, 0x00, 0x00, 0x00, 0x00}
	assertMalformed(t, short, "page without footer")
	assertMalformed(t, []byte{0x07}, "tiny input")

	// Illegal prefixes 0xf5..0xfe and a stray 0xff inside content.
	for _, b := range []byte{0xf5, 0xf8, 0xfe, 0xff} {
		page := fixBuildPage([]fixElement{
			{raw: append([]byte{b}, fixEncodeBacklen(1)...)},
		}, false)
		assertMalformed(t, page, "illegal prefix")
	}

	// Truncated multi-byte bodies.
	assertMalformed(t, fixBuildPage([]fixElement{
		{raw: append([]byte{0xc0}, fixEncodeBacklen(2)...)},
	}, false), "truncated 13-bit integer")
	assertMalformed(t, fixBuildPage([]fixElement{
		{raw: append([]byte{0xf4, 1, 2, 3}, fixEncodeBacklen(9)...)},
	}, false), "truncated 64-bit integer")
}

func assertMalformed(t *testing.T, page []byte, label string) {
	t.Helper()
	if _, err := lp1.Open(page); !errors.Is(err, lp1.ErrMalformed) {
		t.Fatalf("%s: expected ErrMalformed, got %v", label, err)
	}
}

func TestForgedReverseLengthLandsInsidePayload(t *testing.T) {
	// A 16-byte string with a reverse field that decodes to 12: the backward
	// walk lands inside the payload instead of at the body start.
	payload := bytesOf(15, 0x11)
	body := append([]byte{0x8f}, payload...) // body length L = 16
	forged := append(append([]byte(nil), body...), 0x0c)
	page := fixBuildPage([]fixElement{{raw: forged}}, false)
	assertMalformed(t, page, "reverse length landing inside payload")

	// Same shape but the honest minimal field (0x10) must be accepted.
	honest := append(append([]byte(nil), body...), 0x10)
	snap := mustOpen(t, fixBuildPage([]fixElement{{raw: honest}}, false))
	if snap.Count() != 1 {
		t.Fatal("honest page rejected")
	}
}

func TestNonMinimalBacklenRejected(t *testing.T) {
	// Craft a body of exactly L=128: 12-bit string prefix (2) + 126 payload.
	small := bytesOf(126, 0x22)
	l128 := append([]byte{0xe0, 0x7e}, small...)
	if len(l128) != 128 {
		t.Fatalf("setup body length %d", len(l128))
	}

	// L=128 needs 01 80; 00 81 80 adds a redundant leading zero group.
	redundant := append(append([]byte(nil), l128...), 0x00, 0x81, 0x80)
	assertMalformed(t, fixBuildPage([]fixElement{{raw: redundant}}, false),
		"redundant leading zero backlen group")

	// Six reverse groups exceed the five-group limit; the sixth group can never
	// match the known body length within the 1..5 candidate scan.
	six := append(append([]byte(nil), l128...),
		0x01, 0x80, 0x80, 0x80, 0x80, 0x80)
	assertMalformed(t, fixBuildPage([]fixElement{{raw: six}}, false),
		"six-group reverse length")

	// Zero-length body is impossible: every valid body is at least one byte.
	assertMalformed(t, fixBuildPage([]fixElement{
		{raw: []byte{0x80}}, // zero-length string with no reverse field at all
	}, false), "missing reverse length")
}

func TestWideEncodingsAcceptedAndPreserved(t *testing.T) {
	// Integer 5 re-encoded at 64-bit width is non-shortest but readable and
	// must survive Splice byte-for-byte.
	wide, ok := fixEncodeInt(5, 64)
	if !ok {
		t.Fatal("fixture 64-bit encode failed")
	}
	raw := append(append([]byte(nil), wide...), fixEncodeBacklen(len(wide))...)
	page := fixBuildPage([]fixElement{{raw: raw}}, false)
	snap := mustOpen(t, page)
	got := forwardValues(t, snap)
	if got[0].Type() != lp1.TypeInteger || got[0].Int() != 5 {
		t.Fatal("wide integer not decoded")
	}
	next, err := snap.Splice(1, 0, []lp1.Value{lp1.Integer(9)}, 0)
	if err != nil {
		t.Fatal(err)
	}
	model, err := fixDecodePage(next.Bytes())
	if err != nil {
		t.Fatalf("independent model: %v", err)
	}
	if string(model[0].raw) != string(raw) {
		t.Fatalf("wide element re-encoded: % x vs % x", model[0].raw, raw)
	}
	if model[1].value.num != 9 {
		t.Fatal("appended element wrong")
	}
}
