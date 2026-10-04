package recstream

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"reflect"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

// encodeRune encodes one rune in the given encoding.
func encodeRune(enc Encoding, ru rune) []byte {
	switch enc {
	case UTF8:
		var buf [utf8.UTFMax]byte
		n := utf8.EncodeRune(buf[:], ru)
		return buf[:n]
	case UTF16LE, UTF16BE:
		units := utf16.Encode([]rune{ru})
		out := make([]byte, 0, 4)
		for _, u := range units {
			if enc == UTF16LE {
				out = append(out, byte(u), byte(u>>8))
			} else {
				out = append(out, byte(u>>8), byte(u))
			}
		}
		return out
	}
	panic("bad encoding")
}

// recordBytes builds one record: optional BOM, content, optional separator.
func recordBytes(enc Encoding, bom bool, content string, terminated bool) []byte {
	var out []byte
	if bom {
		switch enc {
		case UTF8:
			out = append(out, 0xEF, 0xBB, 0xBF)
		case UTF16LE:
			out = append(out, 0xFF, 0xFE)
		case UTF16BE:
			out = append(out, 0xFE, 0xFF)
		}
	}
	for _, ru := range content {
		out = append(out, encodeRune(enc, ru)...)
	}
	if terminated {
		out = append(out, encodeRune(enc, recordSeparator)...)
	}
	return out
}

// chunkReader yields data in fixed-size chunks to simulate arbitrary splits.
type chunkReader struct {
	data []byte
	n    int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := min(min(len(p), c.n), len(c.data))
	copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

func collect(r *Reader) ([]*Record, error) {
	var recs []*Record
	for {
		rec, err := r.Next()
		if err == io.EOF {
			return recs, nil
		}
		if err != nil {
			return recs, err
		}
		recs = append(recs, rec)
	}
}

// mixedStream contains records in UTF-8 (no BOM), UTF-16LE, UTF-16BE and
// UTF-8 (explicit BOM), the last one unterminated.
func mixedStream() []byte {
	var data []byte
	data = append(data, recordBytes(UTF8, false, "héllo", true)...)
	data = append(data, recordBytes(UTF16LE, true, "世界", true)...)
	data = append(data, recordBytes(UTF16BE, true, "A𝄞B", true)...)
	data = append(data, recordBytes(UTF8, true, "tail", false)...)
	return data
}

func TestMixedRecords(t *testing.T) {
	recs, err := collect(NewReader(bytes.NewReader(mixedStream())))
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(recs) != 4 {
		t.Fatalf("got %d records, want 4", len(recs))
	}
	wantEnc := []Encoding{UTF8, UTF16LE, UTF16BE, UTF8}
	wantText := []string{"héllo", "世界", "A𝄞B", "tail"}
	wantDecl := []bool{false, true, true, true}
	for i, rec := range recs {
		if rec.Encoding != wantEnc[i] {
			t.Errorf("record %d: encoding %v, want %v", i, rec.Encoding, wantEnc[i])
		}
		if rec.String() != wantText[i] {
			t.Errorf("record %d: content %q, want %q", i, rec.String(), wantText[i])
		}
		if rec.HasDecl != wantDecl[i] {
			t.Errorf("record %d: HasDecl %v, want %v", i, rec.HasDecl, wantDecl[i])
		}
	}
}

func TestArbitraryChunking(t *testing.T) {
	data := mixedStream()
	want, err := collect(NewReader(bytes.NewReader(data)))
	if err != nil {
		t.Fatalf("baseline: %v", err)
	}
	sizes := []int{1, 2, 3, 4, 5, 7, 11, 64, 4096}
	for _, n := range sizes {
		got, err := collect(NewReader(&chunkReader{data: data, n: n}))
		if err != nil {
			t.Fatalf("chunk %d: %v", n, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("chunk %d: records differ from baseline", n)
		}
	}
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 20; trial++ {
		got, err := collect(NewReader(&chunkReader{data: data, n: 1 + rng.Intn(9)}))
		if err != nil {
			t.Fatalf("random chunk trial %d: %v", trial, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("random chunk trial %d: records differ from baseline", trial)
		}
	}
}

func TestByteRanges(t *testing.T) {
	data := mixedStream()
	recs, err := collect(NewReader(bytes.NewReader(data)))
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	var prevEnd int64
	for i, rec := range recs {
		pos := prevEnd
		if rec.HasDecl {
			if rec.Decl.Start != pos {
				t.Errorf("record %d: decl starts at %d, want %d", i, rec.Decl.Start, pos)
			}
			pos = rec.Decl.End
		}
		for j, cp := range rec.Points {
			if cp.Start != pos {
				t.Errorf("record %d point %d: starts at %d, want %d", i, j, cp.Start, pos)
			}
			raw := data[cp.Start:cp.End]
			if !bytes.Equal(raw, encodeRune(rec.Encoding, cp.Rune)) {
				t.Errorf("record %d point %d: bytes %x do not re-encode to %U", i, j, raw, cp.Rune)
			}
			pos = cp.End
		}
		// Separator (or EOF) follows the last content byte.
		if pos < int64(len(data)) {
			sepLen := int64(len(encodeRune(rec.Encoding, recordSeparator)))
			pos += sepLen
		}
		prevEnd = pos
	}
	if prevEnd != int64(len(data)) {
		t.Errorf("consumed %d bytes, stream has %d", prevEnd, len(data))
	}
}

func TestMidRecordDeclarationRejected(t *testing.T) {
	cases := map[string][]byte{
		"utf8 bom inside utf8 record": append(
			recordBytes(UTF8, false, "ab", false),
			append([]byte{0xEF, 0xBB, 0xBF}, recordBytes(UTF8, false, "cd", true)...)...),
		"utf16le bom inside utf16le record": append(
			recordBytes(UTF16LE, true, "ab", false),
			append([]byte{0xFF, 0xFE}, recordBytes(UTF16LE, false, "cd", true)...)...),
		"utf8 bom inside utf16be record": append(
			recordBytes(UTF16BE, true, "ab", false),
			recordBytes(UTF16BE, false, "\uFEFFx", true)...),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := collect(NewReader(bytes.NewReader(data)))
			if !errors.Is(err, ErrMidRecordDeclaration) {
				t.Fatalf("err = %v, want ErrMidRecordDeclaration", err)
			}
		})
	}
}

func TestUnpairedSurrogates(t *testing.T) {
	le := func(units ...uint16) []byte {
		var out []byte
		for _, u := range units {
			out = append(out, byte(u), byte(u>>8))
		}
		return out
	}
	bomLE := []byte{0xFF, 0xFE}
	cases := map[string]struct {
		data []byte
		want error
	}{
		"lone high surrogate": {
			append(bomLE, le(0xD83D, 0x1E)...), ErrUnpairedSurrogate,
		},
		"lone low surrogate": {
			append(bomLE, le(0xDE00, 0x1E)...), ErrUnpairedSurrogate,
		},
		"high surrogate then BMP": {
			append(bomLE, le('A', 0xD83D, 'B', 0x1E)...), ErrUnpairedSurrogate,
		},
		"high surrogate at EOF": {
			append(bomLE, le('A', 0xD83D)...), ErrTruncated,
		},
		"valid pair is accepted": {
			append(bomLE, le(0xD834, 0xDD1E, 0x1E)...), nil,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			recs, err := collect(NewReader(bytes.NewReader(tc.data)))
			if tc.want == nil {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				if len(recs) != 1 || recs[0].String() != "𝄞" {
					t.Fatalf("recs = %v, want one record %q", recs, "𝄞")
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			// No pseudo-correct record may be produced from bad input.
			for _, rec := range recs {
				for _, cp := range rec.Points {
					if cp.Rune == utf8.RuneError {
						t.Fatalf("got replacement char in %+v", rec)
					}
				}
			}
		})
	}
}

func TestInvalidUTF8(t *testing.T) {
	cases := map[string][]byte{
		"lone continuation":   {'a', 0x80, 0x1E},
		"overlong slash":      {0xC0, 0xAF, 0x1E},
		"surrogate in utf8":   {0xED, 0xA0, 0x80, 0x1E},
		"out of range":        {0xF5, 0x80, 0x80, 0x80, 0x1E},
		"truncated multibyte": {'a', 0xE4, 0xB8},
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := collect(NewReader(bytes.NewReader(data)))
			if !errors.Is(err, ErrInvalidUTF8) && !errors.Is(err, ErrTruncated) {
				t.Fatalf("err = %v, want ErrInvalidUTF8 or ErrTruncated", err)
			}
		})
	}
}

func TestTruncatedUTF16(t *testing.T) {
	data := []byte{0xFF, 0xFE, 'A', 0x00, 'B'} // odd byte at end
	_, err := collect(NewReader(bytes.NewReader(data)))
	if !errors.Is(err, ErrTruncated) {
		t.Fatalf("err = %v, want ErrTruncated", err)
	}
}

func TestEncodingPersistsWithoutDecl(t *testing.T) {
	var data []byte
	data = append(data, recordBytes(UTF16LE, true, "one", true)...)
	data = append(data, recordBytes(UTF16LE, false, "two", true)...)
	recs, err := collect(NewReader(bytes.NewReader(data)))
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(recs) != 2 || recs[1].Encoding != UTF16LE || recs[1].String() != "two" {
		t.Fatalf("recs = %v", recs)
	}
}

func TestEmptyStream(t *testing.T) {
	recs, err := collect(NewReader(bytes.NewReader(nil)))
	if err != nil || len(recs) != 0 {
		t.Fatalf("recs = %v, err = %v", recs, err)
	}
}

func TestStickyError(t *testing.T) {
	data := append(recordBytes(UTF8, false, "ab", false), 0xEF, 0xBB, 0xBF, 0x1E)
	r := NewReader(bytes.NewReader(data))
	_, err1 := r.Next()
	_, err2 := r.Next()
	if !errors.Is(err1, ErrMidRecordDeclaration) || !errors.Is(err2, ErrMidRecordDeclaration) {
		t.Fatalf("err1 = %v, err2 = %v", err1, err2)
	}
}
