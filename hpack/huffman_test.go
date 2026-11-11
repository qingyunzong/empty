package hpack

import (
	"errors"
	"testing"
)

// huffLiteral builds a complete never-indexed literal (index 0) with an empty
// plain name and payload as a Huffman-encoded value.
func huffLiteral(payload []byte) []byte {
	out := encodeInt(nil, 0x00, 4, 0) // never-indexed, index 0
	out = encodeInt(out, 0x00, 7, 0)  // empty plain name
	out = encodeInt(out, 0x80, 7, len(payload))
	return append(out, payload...)
}

func decodeHuffPayload(t *testing.T, payload []byte) error {
	t.Helper()
	d := newTestDecoder(t, 4096)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	block := huffLiteral(payload)
	if _, err := d.Write(block); err != nil {
		return err
	}
	_, err := d.EndHeaderBlock()
	return err
}

func TestHuffmanValidPadding(t *testing.T) {
	enc := newEncoder()
	// Round-trip strings of several lengths so padding length varies 1..7.
	for _, s := range []string{"a", "ab", "abc", "w", "www.example.com", "custom-header"} {
		payload := enc.huffmanEncode([]byte(s))
		if err := decodeHuffPayload(t, payload); err != nil {
			t.Fatalf("valid padding for %q rejected: %v", s, err)
		}
	}

	// Empty Huffman string (zero length, no encoded bytes) is legal.
	d := newTestDecoder(t, 4096)
	out := feedBlock(t, d, huffLiteral(nil), false)
	assertFields(t, out, []HeaderField{{Name: "", Value: ""}})
}

func TestHuffmanBadPaddingZeroBit(t *testing.T) {
	enc := newEncoder()
	payload := enc.huffmanEncode([]byte("a")) // 'a' = 11000 + three 1-bits
	if len(payload) != 1 {
		t.Fatalf("single-char payload length = %d, want 1", len(payload))
	}
	// Flip the lowest padding bit from 1 to 0: 11000 111 -> 11000 110.
	bad := []byte{payload[0] &^ 0x01}
	err := decodeHuffPayload(t, bad)
	if err == nil || !errors.Is(err, ErrCompression) {
		t.Fatalf("zero padding bit err = %v, want compression error", err)
	}
}

func TestHuffmanPaddingNotEOSPrefix(t *testing.T) {
	// 0xff is eight padding 1-bits: longer than seven and not a valid EOS
	// prefix of a partial symbol, so it must be rejected.
	if err := decodeHuffPayload(t, []byte{0xff}); err == nil {
		t.Fatal("eight 1-bit padding accepted")
	} else if !errors.Is(err, ErrCompression) {
		t.Fatalf("err = %v, want compression error", err)
	}
}

func TestHuffmanEOSInStream(t *testing.T) {
	// The EOS symbol is 30 one-bits followed by two padding ones = 0xff 0xff
	// 0xff 0xff. Decoding EOS inside a string is forbidden.
	eos := []byte{0xff, 0xff, 0xff, 0xff}
	err := decodeHuffPayload(t, eos)
	if err == nil {
		t.Fatal("EOS symbol accepted inside string")
	}
	if !errors.Is(err, ErrCompression) {
		t.Fatalf("EOS err = %v, want compression error", err)
	}

	// EOS must also be rejected when it follows a completed symbol. Build the
	// wire bits for 'a' (11000) immediately followed by the 30-bit EOS code,
	// rounded up to a byte boundary with all-1 padding.
	enc := newEncoder()
	a := enc.huff.Codes[97]
	var cur uint32
	var n uint
	put := func(bits uint32, width uint) {
		cur = cur<<width | bits
		n += width
	}
	put(a.Bits, uint(a.N))
	put(0x3fffffff, 30)
	var payload []byte
	for n >= 8 {
		n -= 8
		payload = append(payload, byte(cur>>n))
		cur &= 1<<n - 1
	}
	if n > 0 {
		pad := 8 - n
		cur = cur<<pad | (1<<pad - 1)
		payload = append(payload, byte(cur))
	}
	if err := decodeHuffPayload(t, payload); !errors.Is(err, ErrCompression) {
		t.Fatalf("EOS after symbol err = %v, want compression error", err)
	}
}

func TestHuffmanInvalidCodePoisons(t *testing.T) {
	// A code that follows no valid trie path and is not 1-padding.
	// 0x00 starts with eight zero bits; no Huffman symbol begins that way in a
	// way that completes, and the bits are 0 so they cannot be padding.
	err := decodeHuffPayload(t, []byte{0x00})
	if err == nil || !errors.Is(err, ErrCompression) {
		t.Fatalf("invalid code err = %v, want compression error", err)
	}

	// After a compression error the connection context stays unusable.
	d := newTestDecoder(t, 4096)
	_ = decodeHuffPayloadOn(t, d, []byte{0x00})
	if !d.Failed() {
		t.Fatal("decoder not marked failed after bad Huffman code")
	}
	if err := d.BeginHeaderBlock(); !errors.Is(err, ErrCompression) {
		t.Fatalf("reuse err = %v, want ErrCompression", err)
	}
}

func decodeHuffPayloadOn(t *testing.T, d *Decoder, payload []byte) error {
	t.Helper()
	if err := d.BeginHeaderBlock(); err != nil {
		return err
	}
	if _, err := d.Write(huffLiteral(payload)); err != nil {
		return err
	}
	_, err := d.EndHeaderBlock()
	return err
}

func TestRFCAppendixCHuffmanVector(t *testing.T) {
	// RFC 7541 appendix C.4.1 literal value "www.example.com".
	payload := []byte{0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff}
	d := newTestDecoder(t, 4096)
	if err := d.BeginHeaderBlock(); err != nil {
		t.Fatal(err)
	}
	nameBlock := encStringPlain("x")
	valueBlock := encodeInt(nil, 0x80, 7, len(payload))
	valueBlock = append(valueBlock, payload...)
	block := append(encLiteralHeader(), append(nameBlock, valueBlock...)...)
	if _, err := d.Write(block); err != nil {
		t.Fatal(err)
	}
	out, err := d.EndHeaderBlock()
	if err != nil {
		t.Fatal(err)
	}
	assertFields(t, out, []HeaderField{{Name: "x", Value: "www.example.com"}})
}

func encStringPlain(s string) []byte {
	return append(encodeInt(nil, 0, 7, len(s)), s...)
}

func encLiteralHeader() []byte {
	// Never-indexed literal, index 0 (name follows as a plain string).
	return encodeInt(nil, 0x00, 4, 0)
}
