package lp1_test

import (
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func TestStringLengthBoundaries(t *testing.T) {
	lengths := []int{0, 1, 63, 64, 65, 4095, 4096, 5000}
	var values []fixValue
	var elems []fixElement
	for _, n := range lengths {
		payload := bytesOf(n, 0xab)
		body, err := lp1.EncodeValue(lp1.String(payload))
		if err != nil {
			t.Fatalf("encode string %d: %v", n, err)
		}
		wantPrefix := byte(0)
		switch {
		case n <= 63:
			wantPrefix = 0x80 | byte(n)
		case n <= 4095:
			wantPrefix = 0xe0 | byte(n>>8)
		default:
			wantPrefix = 0xf0
		}
		if body[0] != wantPrefix {
			t.Fatalf("string %d prefix = %02x want %02x", n, body[0], wantPrefix)
		}
		values = append(values, fixString(payload))
		elems = append(elems, fixBuildElement(body))
	}
	snap := mustOpen(t, fixBuildPage(elems, false))
	assertValueSequence(t, forwardValues(t, snap), values)
	assertValueSequence(t, backwardValues(t, snap), reverseFix(values))

	check := func(n int, wantPrefix []byte) {
		payload := bytesOf(n, 0)
		body, _ := lp1.EncodeValue(lp1.String(payload))
		for i, w := range wantPrefix {
			if body[i] != w {
				t.Fatalf("string len %d prefix % x want % x", n, body[:len(wantPrefix)], wantPrefix)
			}
		}
	}
	check(63, []byte{0xbf})
	check(64, []byte{0xe0, 0x40})
	check(4095, []byte{0xef, 0xff})
	check(4096, []byte{0xf0, 0x00, 0x10, 0x00, 0x00})
}

func TestBodyLengthBacklenBoundaries(t *testing.T) {
	// 6-bit-prefixed strings: body length L = 1 + payload length.
	cases := []struct {
		prefixBits int
		payloadLen int
		wantBack   []byte
	}{
		{14, 125, []byte{0x7f}},               // L = 2 + 125 = 127
		{14, 126, []byte{0x01, 0x80}},         // L = 128
		{32, 16378, []byte{0x7f, 0xff}},       // L = 5 + 16378 = 16383
		{32, 16379, []byte{0x01, 0x80, 0x80}}, // L = 5 + 16379 = 16384
	}
	var values []fixValue
	var elems []fixElement
	for _, tc := range cases {
		payload := bytesOf(tc.payloadLen, 0x33)
		body, ok := fixEncodeString(payload, tc.prefixBits)
		if !ok {
			t.Fatal("fixture string encode failed")
		}
		got := fixEncodeBacklen(len(body))
		if len(got) != len(tc.wantBack) {
			t.Fatalf("L=%d backlen width %d want %d", len(body), len(got), len(tc.wantBack))
		}
		for i := range got {
			if got[i] != tc.wantBack[i] {
				t.Fatalf("L=%d backlen % x want % x", len(body), got, tc.wantBack)
			}
		}
		values = append(values, fixString(payload))
		elems = append(elems, fixBuildElement(body))
	}
	snap := mustOpen(t, fixBuildPage(elems, false))
	assertValueSequence(t, forwardValues(t, snap), values)
	assertValueSequence(t, backwardValues(t, snap), reverseFix(values))
}

func TestLegalFFInsideBody(t *testing.T) {
	intBody, _ := lp1.EncodeValue(lp1.Integer(4095))
	if intBody[1] != 0xff {
		t.Fatalf("4095 body = % x", intBody)
	}
	payload := []byte{0x00, 0xff, 0xff, 0x7f, 0x80}
	strBody, _ := lp1.EncodeValue(lp1.String(payload))
	elems := []fixElement{
		fixBuildElement(intBody),
		fixBuildElement(strBody),
	}
	snap := mustOpen(t, fixBuildPage(elems, false))
	got := forwardValues(t, snap)
	if len(got) != 2 || got[0].Type() != lp1.TypeInteger || got[0].Int() != 4095 {
		t.Fatal("integer with 0xff body not preserved")
	}
	if got[1].Type() != lp1.TypeString {
		t.Fatal("string type lost")
	}
	for i, b := range got[1].Bytes() {
		if b != payload[i] {
			t.Fatalf("string payload mismatch at %d", i)
		}
	}
	back := backwardValues(t, snap)
	if back[0].Type() != lp1.TypeString || back[1].Int() != 4095 {
		t.Fatal("backward traversal over 0xff bodies failed")
	}
}

func TestStringNotCoercedToInteger(t *testing.T) {
	payload := []byte{0x05} // same byte as integer 5, but a distinct string value
	elems := []fixElement{
		fixBuildElement([]byte{0x05}),
		fixBuildElement(mustEncode(lp1.String(payload))),
	}
	snap := mustOpen(t, fixBuildPage(elems, false))
	got := forwardValues(t, snap)
	if got[0].Type() != lp1.TypeInteger || got[0].Int() != 5 {
		t.Fatal("first value must be integer 5")
	}
	if got[1].Type() != lp1.TypeString || len(got[1].Bytes()) != 1 || got[1].Bytes()[0] != 5 {
		t.Fatal("numeric-looking string must stay a string")
	}
}

func mustEncode(v lp1.Value) []byte {
	b, err := lp1.EncodeValue(v)
	if err != nil {
		panic(err)
	}
	return b
}
