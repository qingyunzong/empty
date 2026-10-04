package tlv

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// build wraps content in n nested indefinite-length constructed values.
func wrapIndefinite(n int, content []byte) []byte {
	out := append([]byte(nil), content...)
	for i := 0; i < n; i++ {
		out = append(append([]byte{0x30, 0x80}, out...), 0x00, 0x00)
	}
	return out
}

func TestParseValid(t *testing.T) {
	long128 := "048180" + strings.Repeat("aa", 128)
	long256 := "04820100" + strings.Repeat("bb", 256)
	cases := []struct {
		name string
		hex  string
	}{
		{"primitive short form", "0403010203"},
		{"primitive empty", "0400"},
		{"primitive long form 128", long128},
		{"primitive long form 256", long256},
		{"constructed definite", "3006040101040102"},
		{"constructed indefinite", "30800401010401020000"},
		{"constructed empty definite", "3000"},
		{"constructed empty indefinite", "30800000"},
		{"nested mixed", "308030030401010401ff0000"},
		{"indefinite in definite", "300730800401010000"},
		{"context constructed", "a003020101"},
		{"private primitive", "c2017f"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := mustHex(t, tc.hex)
			n, err := Parse(data)
			if err != nil {
				t.Fatalf("Parse failed: %v", err)
			}
			if n == nil {
				t.Fatal("Parse returned nil node")
			}
		})
	}
}

func TestParseInvalid(t *testing.T) {
	cases := []struct {
		name    string
		hex     string
		wantMsg string
		wantOff int
	}{
		{"empty input", "", "truncated header", 0},
		{"tag only", "04", "truncated header", 0},
		{"truncated content", "040201", "beyond enclosing value", 0},
		{"non-minimal long form", "04817f" + strings.Repeat("00", 127), "non-minimal length: long form", 2},
		{"non-minimal leading zero", "04820080" + strings.Repeat("00", 128), "non-minimal length: leading zero", 2},
		{"non-minimal 4-byte leading zero", "048400000100", "non-minimal length: leading zero", 2},
		{"reserved length-of-length", "04ff", "reserved length-of-length", 1},
		{"length-of-length too large", "04850000000100", "exceeds 4 bytes", 1},
		{"truncated long-form length", "0482ff", "truncated long-form length", 2},
		{"indefinite on primitive", "04800000", "indefinite length on primitive", 1},
		{"stray end-of-contents", "0000", "end-of-contents marker", 0},
		{"unterminated indefinite", "3080040101", "unterminated indefinite-length", 5},
		{"child overruns parent", "3003040501", "beyond enclosing value", 2},
		{"grandchild overruns parent", "30053003040501", "beyond enclosing value", 4},
		{"trailing bytes", "04010100", "trailing bytes", 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := mustHex(t, tc.hex)
			_, err := Parse(data)
			if err == nil {
				t.Fatalf("Parse(%x) succeeded, want error", data)
			}
			pe, ok := err.(*Error)
			if !ok {
				t.Fatalf("error type %T, want *Error", err)
			}
			if !strings.Contains(pe.Msg, tc.wantMsg) {
				t.Errorf("error %q does not contain %q", pe.Msg, tc.wantMsg)
			}
			if pe.Offset != tc.wantOff {
				t.Errorf("offset = %d, want %d", pe.Offset, tc.wantOff)
			}
			if pe.Offset < 0 || pe.Offset > len(data) {
				t.Errorf("offset %d outside input of %d bytes", pe.Offset, len(data))
			}
		})
	}
}

func TestDepthLimit(t *testing.T) {
	prim := mustHex(t, "040101")
	ok := wrapIndefinite(MaxDepth, prim)
	if _, err := Parse(ok); err != nil {
		t.Errorf("depth %d rejected: %v", MaxDepth, err)
	}
	deep := wrapIndefinite(MaxDepth+1, prim)
	_, err := Parse(deep)
	if err == nil {
		t.Fatalf("depth %d accepted", MaxDepth+1)
	}
	pe, okErr := err.(*Error)
	if !okErr || !strings.Contains(pe.Msg, "depth exceeds limit") {
		t.Errorf("error = %v, want depth limit error", err)
	}
}

// TestTruncation verifies every byte-by-byte prefix of valid encodings
// fails with an error offset inside the truncated input.
func TestTruncation(t *testing.T) {
	valids := []string{
		"0403010203",
		"048180" + strings.Repeat("aa", 128),
		"3006040101040102",
		"30800401010401020000",
		"308030030401010401ff0000",
	}
	for _, h := range valids {
		data := mustHex(t, h)
		if _, err := Parse(data); err != nil {
			t.Fatalf("valid input %x rejected: %v", data, err)
		}
		for i := 0; i < len(data); i++ {
			_, err := Parse(data[:i])
			if err == nil {
				t.Fatalf("truncated %x[:%d] parsed successfully", data, i)
			}
			pe, ok := err.(*Error)
			if !ok {
				t.Fatalf("truncated %x[:%d]: error type %T", data, i, err)
			}
			if pe.Offset < 0 || pe.Offset > i {
				t.Errorf("truncated %x[:%d]: offset %d outside truncated input", data, i, pe.Offset)
			}
		}
	}
}

// TestRoundTrip verifies Parse followed by Encode reproduces the input.
func TestRoundTrip(t *testing.T) {
	valids := []string{
		"0403010203",
		"0400",
		"048180" + strings.Repeat("aa", 128),
		"04820100" + strings.Repeat("bb", 256),
		"3006040101040102",
		"30800401010401020000",
		"30800000",
		"3000",
		"308030030401010401ff0000",
		"300730800401010000",
		"a003020101",
		"c2017f",
	}
	for _, h := range valids {
		data := mustHex(t, h)
		n, err := Parse(data)
		if err != nil {
			t.Fatalf("Parse(%x) failed: %v", data, err)
		}
		got := n.Encode()
		if !bytes.Equal(got, data) {
			t.Errorf("round trip mismatch:\n in: %x\nout: %x", data, got)
		}
	}
}

func TestStructure(t *testing.T) {
	n, err := Parse(mustHex(t, "30800401010401020000"))
	if err != nil {
		t.Fatal(err)
	}
	if !n.Constructed || !n.Indefinite {
		t.Errorf("root: constructed=%v indefinite=%v, want true true", n.Constructed, n.Indefinite)
	}
	if len(n.Children) != 2 {
		t.Fatalf("root has %d children, want 2", len(n.Children))
	}
	for i, c := range n.Children {
		if c.Constructed {
			t.Errorf("child %d unexpectedly constructed", i)
		}
		if !bytes.Equal(c.Value, []byte{byte(i + 1)}) {
			t.Errorf("child %d value = %x, want %02x", i, c.Value, i+1)
		}
	}
}
