package dataeng_test

import (
	"bytes"
	"errors"
	"testing"

	"example.org/dataeng13/q0005"
)

func TestDecodeUTF8InvalidBytesIndividually(t *testing.T) {
	tests := []struct {
		name         string
		input        []byte
		want         []byte
		replacements int
	}{
		{
			name:         "valid text and emoji",
			input:        hexBytes(t, "41e282acf09f988042"),
			want:         hexBytes(t, "41e282acf09f988042"),
			replacements: 0,
		},
		{
			name:         "invalid lead does not swallow ascii",
			input:        hexBytes(t, "41e228a142"),
			want:         hexBytes(t, "41efbfbd28efbfbd42"),
			replacements: 2,
		},
		{
			name:         "truncated three byte sequence",
			input:        hexBytes(t, "f09f92"),
			want:         hexBytes(t, "efbfbdefbfbdefbfbd"),
			replacements: 3,
		},
		{
			name:         "truncated sequence before valid ascii",
			input:        hexBytes(t, "e28241"),
			want:         hexBytes(t, "efbfbdefbfbd41"),
			replacements: 2,
		},
		{
			name:         "overlong encoding",
			input:        hexBytes(t, "c0af"),
			want:         hexBytes(t, "efbfbdefbfbd"),
			replacements: 2,
		},
		{
			name:         "valid replacement character is not counted",
			input:        hexBytes(t, "efbfbd"),
			want:         hexBytes(t, "efbfbd"),
			replacements: 0,
		},
		{
			name:         "encoded surrogate is invalid",
			input:        hexBytes(t, "eda080"),
			want:         hexBytes(t, "efbfbdefbfbdefbfbd"),
			replacements: 3,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			text, replacements, err := dataeng.Decode("utf-8", test.input)
			if err != nil {
				t.Fatal(err)
			}
			if got := []byte(text); !bytes.Equal(got, test.want) {
				t.Fatalf("decoded bytes = %x, want %x", got, test.want)
			}
			if replacements != test.replacements {
				t.Fatalf("replacements = %d, want %d", replacements, test.replacements)
			}
		})
	}
}

func TestDecodeUTF16(t *testing.T) {
	tests := []struct {
		name         string
		charset      string
		input        []byte
		want         []byte
		replacements int
	}{
		{
			name:         "little endian valid pair",
			charset:      "utf-16le",
			input:        hexBytes(t, "3dd800de"),
			want:         hexBytes(t, "f09f9880"),
			replacements: 0,
		},
		{
			name:         "big endian valid pair",
			charset:      "utf-16be",
			input:        hexBytes(t, "d83dde00"),
			want:         hexBytes(t, "f09f9880"),
			replacements: 0,
		},
		{
			name:         "unpaired high does not swallow next unit",
			charset:      "utf-16le",
			input:        hexBytes(t, "00d8410000dc"),
			want:         hexBytes(t, "efbfbd41efbfbd"),
			replacements: 2,
		},
		{
			name:         "unpaired high does not swallow following pair",
			charset:      "utf-16le",
			input:        hexBytes(t, "00d83dd800de"),
			want:         hexBytes(t, "efbfbdf09f9880"),
			replacements: 1,
		},
		{
			name:         "odd final byte",
			charset:      "utf-16le",
			input:        hexBytes(t, "4100ff"),
			want:         hexBytes(t, "41efbfbd"),
			replacements: 1,
		},
		{
			name:         "valid bmp character",
			charset:      "utf-16be",
			input:        hexBytes(t, "4f60"),
			want:         hexBytes(t, "e4bda0"),
			replacements: 0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			text, replacements, err := dataeng.Decode(test.charset, test.input)
			if err != nil {
				t.Fatal(err)
			}
			if got := []byte(text); !bytes.Equal(got, test.want) {
				t.Fatalf("decoded bytes = %x, want %x", got, test.want)
			}
			if replacements != test.replacements {
				t.Fatalf("replacements = %d, want %d", replacements, test.replacements)
			}
		})
	}
}

func TestDecodeSingleByteCharsets(t *testing.T) {
	text, replacements, err := dataeng.Decode("windows-1252", hexBytes(t, "809341"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := []byte(text), hexBytes(t, "e282ace2809c41"); !bytes.Equal(got, want) {
		t.Fatalf("windows-1252 bytes = %x, want %x", got, want)
	}
	if replacements != 0 {
		t.Fatalf("windows-1252 replacements = %d, want 0", replacements)
	}

	text, replacements, err = dataeng.Decode("iso-8859-1", hexBytes(t, "8093"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := []byte(text), hexBytes(t, "c280c293"); !bytes.Equal(got, want) {
		t.Fatalf("iso-8859-1 bytes = %x, want %x", got, want)
	}
	if replacements != 0 {
		t.Fatalf("iso-8859-1 replacements = %d, want 0", replacements)
	}

	text, replacements, err = dataeng.Decode("us-ascii", hexBytes(t, "418042"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := []byte(text), hexBytes(t, "41efbfbd42"); !bytes.Equal(got, want) {
		t.Fatalf("us-ascii bytes = %x, want %x", got, want)
	}
	if replacements != 1 {
		t.Fatalf("us-ascii replacements = %d, want 1", replacements)
	}
}

func TestDecodePageUndecided(t *testing.T) {
	decoded, err := dataeng.DecodePage("", []byte{0xEF}, false)
	if !errors.Is(err, dataeng.ErrUndecided) {
		t.Fatalf("err = %v, want ErrUndecided", err)
	}
	if !decoded.Undecided || decoded.Text != "" || decoded.Source != "undecided" {
		t.Fatalf("decoded = %+v", decoded)
	}
}

func TestIncompleteHalfSequenceStillDecodes(t *testing.T) {
	sample := []byte("ab\xe2\x82")
	decision := dataeng.Resolve("", sample, false)
	if decision.Undecided || decision.Charset != "utf-8" || decision.Source != "default" {
		t.Fatalf("decision = %+v, want UTF-8 default", decision)
	}
	decoded, err := dataeng.DecodePage("", sample, false)
	if err != nil {
		t.Fatal(err)
	}
	want := hexBytes(t, "6162efbfbdefbfbd")
	if got := []byte(decoded.Text); !bytes.Equal(got, want) {
		t.Fatalf("decoded bytes = %x, want %x", got, want)
	}
	if decoded.Replacements != 2 {
		t.Fatalf("replacements = %d, want 2", decoded.Replacements)
	}
}

func TestDecodeUnsupportedCharset(t *testing.T) {
	_, _, err := dataeng.Decode("made-up-charset", []byte("text"))
	if !errors.Is(err, dataeng.ErrUnsupportedCharset) {
		t.Fatalf("err = %v, want ErrUnsupportedCharset", err)
	}
}
