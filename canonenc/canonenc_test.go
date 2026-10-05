package canonenc

import (
	"bytes"
	"errors"
	"math/rand"
	"testing"
)

// allBytes returns every byte value 0x00..0xFF in order.
func allBytes() []byte {
	b := make([]byte, 256)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

func TestRoundTripAllBytes(t *testing.T) {
	for i := 0; i < 256; i++ {
		src := []byte{byte(i)}
		got, err := Decode(Encoded(src))
		if err != nil {
			t.Fatalf("byte 0x%02x: decode error: %v", i, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("byte 0x%02x: round trip gave %x", i, got)
		}
	}
	// Combined buffer containing every byte value.
	src := allBytes()
	got, err := Decode(Encoded(src))
	if err != nil {
		t.Fatalf("all-bytes buffer: decode error: %v", err)
	}
	if !bytes.Equal(got, src) {
		t.Fatalf("all-bytes buffer: round trip mismatch")
	}
}

func TestEncodedNeverContainsDelimiterOrControlBytes(t *testing.T) {
	enc := Encoded(allBytes())
	for i, b := range enc {
		if b == DelimiterByte {
			t.Fatalf("encoded output contains delimiter at offset %d", i)
		}
		if b < 0x20 || b == 0x7F {
			t.Fatalf("encoded output contains control byte 0x%02x at offset %d", b, i)
		}
	}
}

func TestArbitraryChunking(t *testing.T) {
	src := allBytes()
	enc := Encoded(src)

	// Every two-chunk split point.
	for cut := 0; cut <= len(enc); cut++ {
		d := NewStreamDecoder()
		if _, err := d.Write(enc[:cut]); err != nil {
			t.Fatalf("cut=%d: first chunk: %v", cut, err)
		}
		if _, err := d.Write(enc[cut:]); err != nil {
			t.Fatalf("cut=%d: second chunk: %v", cut, err)
		}
		if err := d.Close(); err != nil {
			t.Fatalf("cut=%d: close: %v", cut, err)
		}
		if !bytes.Equal(d.Bytes(), src) {
			t.Fatalf("cut=%d: decoded %x, want %x", cut, d.Bytes(), src)
		}
	}

	// Random multi-chunk splits, including empty chunks.
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		d := NewStreamDecoder()
		pos := 0
		for pos < len(enc) {
			n := rng.Intn(7) // chunk sizes 0..6 bytes
			if n > len(enc)-pos {
				n = len(enc) - pos
			}
			if _, err := d.Write(enc[pos : pos+n]); err != nil {
				t.Fatalf("trial=%d pos=%d: %v", trial, pos, err)
			}
			pos += n
		}
		if err := d.Close(); err != nil {
			t.Fatalf("trial=%d: close: %v", trial, err)
		}
		if !bytes.Equal(d.Bytes(), src) {
			t.Fatalf("trial=%d: decoded mismatch", trial)
		}
	}
}

func TestDoubleEncodedInput(t *testing.T) {
	src := allBytes()
	once := Encoded(src)
	twice := Encoded(once)

	// Decoding the double encoding must yield the single encoding...
	mid, err := Decode(twice)
	if err != nil {
		t.Fatalf("first decode: %v", err)
	}
	if !bytes.Equal(mid, once) {
		t.Fatalf("double decode stage 1 mismatch")
	}
	// ...and decoding again must yield the original bytes.
	got, err := Decode(mid)
	if err != nil {
		t.Fatalf("second decode: %v", err)
	}
	if !bytes.Equal(got, src) {
		t.Fatalf("double decode stage 2 mismatch")
	}

	// Streamed, byte-at-a-time.
	d := NewStreamDecoder()
	for _, b := range twice {
		if _, err := d.Write([]byte{b}); err != nil {
			t.Fatalf("stream double-encoded: %v", err)
		}
	}
	if err := d.Close(); err != nil {
		t.Fatalf("stream double-encoded close: %v", err)
	}
	if !bytes.Equal(d.Bytes(), once) {
		t.Fatalf("streamed double decode mismatch")
	}
}

func TestNonCanonicalRejected(t *testing.T) {
	cases := map[string][]byte{
		// Escape of a byte that never requires escaping ('A' = 0x41).
		"escaped printable": {EscapeByte, escapePayload('A')},
		// Payload byte that is itself not an escape payload ('A' as payload
		// decodes to 0xC1, which is not in the must-escape set).
		"invalid payload": {EscapeByte, 'A'},
		// Escape of a space (0x20), just above the control range.
		"escaped space": {EscapeByte, escapePayload(0x20)},
		// Non-canonical sequence embedded in otherwise valid input.
		"embedded": {'o', 'k', EscapeByte, escapePayload('z'), 'o', 'k'},
	}
	for name, in := range cases {
		if _, err := Decode(in); !errors.Is(err, ErrNonCanonical) {
			t.Errorf("%s: Decode err = %v, want ErrNonCanonical", name, err)
		}
		d := NewStreamDecoder()
		if _, err := d.Write(in); !errors.Is(err, ErrNonCanonical) {
			t.Errorf("%s: stream Write err = %v, want ErrNonCanonical", name, err)
		}
	}
}

func TestTruncationVsIllegal(t *testing.T) {
	// Truncated: stream ends right after the escape byte.
	if _, err := Decode([]byte{'a', EscapeByte}); !errors.Is(err, ErrIncomplete) {
		t.Errorf("truncated: Decode err = %v, want ErrIncomplete", err)
	}
	if _, err := Decode([]byte{EscapeByte}); !errors.Is(err, ErrIncomplete) {
		t.Errorf("lone escape: Decode err = %v, want ErrIncomplete", err)
	}

	// A dangling escape mid-stream is not yet an error...
	d := NewStreamDecoder()
	if _, err := d.Write([]byte{'a', EscapeByte}); err != nil {
		t.Fatalf("write with dangling escape: %v", err)
	}
	// ...it becomes ErrIncomplete only at end of stream.
	if err := d.Close(); !errors.Is(err, ErrIncomplete) {
		t.Errorf("close with dangling escape: err = %v, want ErrIncomplete", err)
	}

	// Illegal input is a different, immediately-reported error.
	d2 := NewStreamDecoder()
	if _, err := d2.Write([]byte{EscapeByte, 'A'}); !errors.Is(err, ErrNonCanonical) {
		t.Errorf("illegal: Write err = %v, want ErrNonCanonical", err)
	}
	if errors.Is(ErrNonCanonical, ErrIncomplete) || errors.Is(ErrIncomplete, ErrNonCanonical) {
		t.Errorf("ErrIncomplete and ErrNonCanonical must be distinguishable")
	}
}

func TestSignatureBindsEncodedBytes(t *testing.T) {
	key := []byte("test-key")
	raw := allBytes()
	enc := Encoded(raw)

	sig := Sign(key, enc)
	if !Verify(key, enc, sig) {
		t.Fatal("signature over encoded bytes does not verify")
	}

	// A signature over the raw plaintext must not verify against the
	// encoded bytes: the signature binds the encoded form.
	rawSig := Sign(key, raw)
	if Verify(key, enc, rawSig) {
		t.Fatal("signature over raw bytes verified against encoded bytes")
	}

	// Tampering with any encoded byte invalidates the signature.
	for _, pos := range []int{0, len(enc) / 2, len(enc) - 1} {
		tampered := bytes.Clone(enc)
		tampered[pos] ^= 0x01
		if Verify(key, tampered, sig) {
			t.Fatalf("signature verified after tampering byte %d", pos)
		}
	}

	// Wrong key and wrong length are rejected.
	if Verify([]byte("other-key"), enc, sig) {
		t.Fatal("signature verified under wrong key")
	}
	if Verify(key, enc, sig[:len(sig)-1]) {
		t.Fatal("truncated signature verified")
	}

	// VerifyAndDecode authenticates before decoding.
	got, err := VerifyAndDecode(key, enc, sig)
	if err != nil {
		t.Fatalf("VerifyAndDecode: %v", err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatal("VerifyAndDecode decoded mismatch")
	}
	if _, err := VerifyAndDecode(key, enc, rawSig); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("VerifyAndDecode with bad sig: err = %v, want ErrBadSignature", err)
	}
}
