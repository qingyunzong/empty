package canonenc

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
)

// allBytes returns a payload containing every byte value 0x00-0xFF.
func allBytes() []byte {
	b := make([]byte, 256)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

// TestRoundTripAllBytes verifies that every possible byte, individually
// and as a combined payload, survives an encode/decode round trip.
func TestRoundTripAllBytes(t *testing.T) {
	for i := 0; i < 256; i++ {
		src := []byte{byte(i)}
		got, err := DecodeString(EncodeString(src))
		if err != nil {
			t.Fatalf("byte 0x%02X: decode error: %v", i, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("byte 0x%02X: round trip gave %x", i, got)
		}
	}
	src := allBytes()
	got, err := DecodeString(EncodeString(src))
	if err != nil {
		t.Fatalf("all-bytes payload: decode error: %v", err)
	}
	if !bytes.Equal(got, src) {
		t.Fatalf("all-bytes payload: round trip mismatch")
	}
}

// TestEncodeCanonicalForm checks that encoded output never contains a
// bare must-escape byte and that every escape uses uppercase hex.
func TestEncodeCanonicalForm(t *testing.T) {
	enc := EncodeString(allBytes())
	for i := 0; i < len(enc); i++ {
		c := enc[i]
		if c == EscapeByte {
			if i+2 >= len(enc) {
				t.Fatalf("dangling escape at %d in %q", i, enc)
			}
			for _, d := range enc[i+1 : i+3] {
				if !(d >= '0' && d <= '9' || d >= 'A' && d <= 'F') {
					t.Fatalf("non-uppercase-hex digit %q at %d", d, i)
				}
			}
			i += 2
			continue
		}
		if MustEscape(c) {
			t.Fatalf("bare must-escape byte 0x%02X at %d", c, i)
		}
	}
}

// TestGoldenEncodings pins the canonical spelling of representative bytes.
func TestGoldenEncodings(t *testing.T) {
	cases := []struct {
		src  []byte
		want string
	}{
		{[]byte("hello"), "hello"},
		{[]byte{0x00}, "%00"},
		{[]byte{0x0A}, "%0A"},
		{[]byte{0x1F}, "%1F"},
		{[]byte{0x7F}, "%7F"},
		{[]byte{'%'}, "%25"},
		{[]byte("a\nb%"), "a%0Ab%25"},
	}
	for _, c := range cases {
		if got := string(EncodeString(c.src)); got != c.want {
			t.Errorf("Encode(%x) = %q, want %q", c.src, got, c.want)
		}
	}
}

// TestRejectNonCanonical verifies that equivalent-but-non-canonical
// spellings are rejected with ErrInvalid.
func TestRejectNonCanonical(t *testing.T) {
	invalid := []struct {
		name string
		in   string
	}{
		{"lowercase hex", "%0a"},
		{"lowercase hex both", "%ff"},
		{"mixed case hex", "%Ff"},
		{"escape of printable A", "%41"},
		{"escape of space", "%20"},
		{"escape of DEL-free plain byte", "%7E"},
		{"bare control byte", "a\x01b"},
		{"bare NUL", "\x00"},
		{"bare DEL", "\x7f"},
		{"non-hex digit", "%GG"},
		{"non-hex second digit", "%1G"},
		{"percent then text", "%xy"},
	}
	for _, c := range invalid {
		t.Run(c.name, func(t *testing.T) {
			if _, err := DecodeString([]byte(c.in)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("Decode(%q) error = %v, want ErrInvalid", c.in, err)
			}
			if Valid([]byte(c.in)) {
				t.Fatalf("Valid(%q) = true, want false", c.in)
			}
		})
	}
}

// TestTruncatedIsIncomplete verifies that truncation at any point of an
// escape sequence is reported as ErrIncomplete, never ErrInvalid.
func TestTruncatedIsIncomplete(t *testing.T) {
	truncated := []string{"%", "abc%", "%4", "%0A%1", "ok%2"}
	for _, in := range truncated {
		if _, err := DecodeString([]byte(in)); !errors.Is(err, ErrIncomplete) {
			t.Errorf("Decode(%q) error = %v, want ErrIncomplete", in, err)
		}
		if errors.Is(mustErr(DecodeString([]byte(in))), ErrInvalid) {
			t.Errorf("Decode(%q) reported ErrInvalid for mere truncation", in)
		}
	}
}

func mustErr(_ []byte, err error) error { return err }

// TestEveryTruncationPoint truncates a real encoding at every possible
// length and checks the error is either nil (complete prefix) or
// ErrIncomplete — never ErrInvalid.
func TestEveryTruncationPoint(t *testing.T) {
	enc := EncodeString(allBytes())
	for n := 0; n <= len(enc); n++ {
		_, err := DecodeString(enc[:n])
		if n == len(enc) {
			if err != nil {
				t.Fatalf("full input: unexpected error %v", err)
			}
			continue
		}
		if err == nil {
			continue // prefix ended on a complete boundary
		}
		if !errors.Is(err, ErrIncomplete) {
			t.Fatalf("prefix len %d: got %v, want ErrIncomplete", n, err)
		}
	}
}

// TestDoubleEncoding verifies that encoding an already-encoded payload
// round-trips: decoding twice recovers the original plaintext, and
// decoding once recovers the single-encoded form.
func TestDoubleEncoding(t *testing.T) {
	payloads := [][]byte{
		allBytes(),
		[]byte("plain text with % and \n newline"),
		[]byte("%25%0A%41"), // looks encoded, is just data
		{},
	}
	for _, src := range payloads {
		once := EncodeString(src)
		twice := EncodeString(once)
		if !Valid(twice) {
			t.Fatalf("double encoding of %x is not valid", src)
		}
		back1, err := DecodeString(twice)
		if err != nil {
			t.Fatalf("first decode of double encoding: %v", err)
		}
		if !bytes.Equal(back1, once) {
			t.Fatalf("double decode step 1 mismatch for %x", src)
		}
		back2, err := DecodeString(back1)
		if err != nil {
			t.Fatalf("second decode of double encoding: %v", err)
		}
		if !bytes.Equal(back2, src) {
			t.Fatalf("double decode step 2 mismatch for %x", src)
		}
	}
}

// TestEncodedLenBound checks the worst-case length bound.
func TestEncodedLenBound(t *testing.T) {
	enc := EncodeString(allBytes())
	if len(enc) > EncodedLen(256) {
		t.Fatalf("encoded len %d exceeds bound %d", len(enc), EncodedLen(256))
	}
}

// Example demonstrates the canonical codec end to end.
func Example() {
	enc := EncodeString([]byte("a\nb%"))
	fmt.Println(string(enc))
	dec, _ := DecodeString(enc)
	fmt.Printf("%q\n", dec)
	// Output:
	// a%0Ab%25
	// "a\nb%"
}
