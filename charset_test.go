package dataeng_test

import (
	"encoding/hex"
	"strings"
	"testing"

	"example.org/dataeng13/q0005"
)

func hexBytes(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(strings.ReplaceAll(value, " ", ""))
	if err != nil {
		t.Fatalf("bad literal hex %q: %v", value, err)
	}
	return decoded
}

func utf16Input(text string, bigEndian bool) []byte {
	units := make([]byte, 0, len(text)*2)
	for _, r := range text {
		if r > 0xFFFF {
			r -= 0x10000
			high := 0xD800 + (r >> 10)
			low := 0xDC00 + (r & 0x3FF)
			units = appendUnit(units, high, bigEndian)
			units = appendUnit(units, low, bigEndian)
			continue
		}
		units = appendUnit(units, r, bigEndian)
	}
	return units
}

func appendUnit(dst []byte, unit rune, bigEndian bool) []byte {
	if bigEndian {
		return append(dst, byte(unit>>8), byte(unit))
	}
	return append(dst, byte(unit), byte(unit>>8))
}

func TestBOMWinsOverTransportAndMeta(t *testing.T) {
	body := append(
		[]byte{0xEF, 0xBB, 0xBF},
		[]byte(`<meta charset="windows-1252"><p>café</p>`)...,
	)

	decision := dataeng.Resolve("iso-8859-1", body, true)
	if decision.Charset != "utf-8" || decision.Source != "bom" {
		t.Fatalf("decision = %+v, want utf-8 from BOM", decision)
	}
	if decision.BOMLen != 3 || !decision.HasBOM || !decision.Decided || decision.Undecided {
		t.Fatalf("BOM metadata = %+v", decision)
	}

	decoded, err := dataeng.DecodePage("iso-8859-1", body, true)
	if err != nil {
		t.Fatal(err)
	}
	wantText := `<meta charset="windows-1252"><p>café</p>`
	if decoded.Text != wantText {
		t.Fatalf("text = %q, want %q", decoded.Text, wantText)
	}
	wantBytes := hexBytes(t, "3c6d65746120636861727365743d2277696e646f77732d31323532223e3c703e636166c3a93c2f703e")
	if got := []byte(decoded.Text); string(got) != string(wantBytes) {
		t.Fatalf("text bytes = %x, want %x", got, wantBytes)
	}
	if decoded.Replacements != 0 {
		t.Fatalf("replacements = %d, want 0", decoded.Replacements)
	}
}

func TestUTF16BOMsWinAndAreStripped(t *testing.T) {
	const text = `<meta charset="windows-1252">你好`
	tests := []struct {
		name      string
		bom       []byte
		bigEndian bool
		charset   string
	}{
		{"little endian", []byte{0xFF, 0xFE}, false, "utf-16le"},
		{"big endian", []byte{0xFE, 0xFF}, true, "utf-16be"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := append(append([]byte(nil), test.bom...), utf16Input(text, test.bigEndian)...)
			decision := dataeng.Resolve("utf-8", body, true)
			if decision.Charset != test.charset || decision.Source != "bom" || decision.BOMLen != 2 {
				t.Fatalf("decision = %+v", decision)
			}
			decoded, err := dataeng.DecodePage("utf-8", body, true)
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Text != text {
				t.Fatalf("text = %q, want %q", decoded.Text, text)
			}
			if decoded.Replacements != 0 {
				t.Fatalf("replacements = %d, want 0", decoded.Replacements)
			}
		})
	}
}

func TestTransportCharsetBeatsMeta(t *testing.T) {
	sample := []byte(`<meta charset="utf-8"><p>` + "\x93" + `</p>`)
	decision := dataeng.Resolve("windows-1252", sample, true)
	if decision.Charset != "windows-1252" || decision.Source != "transport" {
		t.Fatalf("decision = %+v", decision)
	}

	decoded, err := dataeng.DecodePage("windows-1252", sample, true)
	if err != nil {
		t.Fatal(err)
	}
	wantText := `<meta charset="utf-8"><p>“</p>`
	if decoded.Text != wantText {
		t.Fatalf("text = %q, want %q", decoded.Text, wantText)
	}
	wantBytes := hexBytes(t, "3c6d65746120636861727365743d227574662d38223e3c703ee2809c3c2f703e")
	if got := []byte(decoded.Text); string(got) != string(wantBytes) {
		t.Fatalf("text bytes = %x, want %x", got, wantBytes)
	}
}

func TestTransportParsingAndEmptyTransport(t *testing.T) {
	sample := []byte(`<meta charset="windows-1252">`)

	decision := dataeng.Resolve(`text/html; charset="iso-8859-1"`, sample, true)
	if decision.Charset != "iso-8859-1" || decision.Source != "transport" {
		t.Fatalf("decision = %+v", decision)
	}

	decision = dataeng.Resolve(" \t\r\n", sample, true)
	if decision.Charset != "windows-1252" || decision.Source != "meta" {
		t.Fatalf("whitespace transport decision = %+v", decision)
	}
}

func TestMetaSelection(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "script declaration is ignored",
			input: `<script>var fake = "<meta charset=windows-1252>";</script><meta charset="iso-8859-1">`,
			want:  "iso-8859-1",
		},
		{
			name:  "style declaration is ignored",
			input: `<style>/* <meta charset=windows-1252> */</style><META CHARSET=UTF-16LE>`,
			want:  "utf-16le",
		},
		{
			name:  "attributed script declaration is ignored",
			input: `<script data-x=">"><meta charset=windows-1252></script><meta charset=utf-8>`,
			want:  "utf-8",
		},
		{
			name:  "earliest meta wins",
			input: `<meta charset="windows-1252"><meta charset="utf-8">`,
			want:  "windows-1252",
		},
		{
			name:  "meta without charset is skipped",
			input: `<meta name=description content="x"><meta charset=windows-1252>`,
			want:  "windows-1252",
		},
		{
			name:  "content type pragma",
			input: `<META HTTP-EQUIV=Content-Type CONTENT="text/html; charset=UTF-16LE">`,
			want:  "utf-16le",
		},
		{
			name:  "mime content without http equiv",
			input: `<meta content="text/html;charset=UTF-16BE">`,
			want:  "utf-16be",
		},
		{
			name:  "unquoted self closing meta",
			input: `<meta charset=utf-8/>`,
			want:  "utf-8",
		},
		{
			name:  "spaced attribute and single quotes",
			input: `<meta charset = 'ISO-8859-1' >`,
			want:  "iso-8859-1",
		},
		{
			name:  "uppercase script close",
			input: `<SCRIPT>fake <meta charset=windows-1252></SCRIPT><meta charset=utf-8>`,
			want:  "utf-8",
		},
		{
			name:  "commented declaration is ignored",
			input: `<!-- <meta charset=windows-1252> --><meta charset=iso-8859-1>`,
			want:  "iso-8859-1",
		},
		{
			name:  "refresh content is not a charset",
			input: `<meta http-equiv=refresh content="0;url=/charset=windows-1252"><meta charset=utf-8>`,
			want:  "utf-8",
		},
		{
			name:  "description content is not a charset",
			input: `<meta name=description content="charset=windows-1252">`,
			want:  "utf-8",
		},
		{
			name:  "fallback is UTF-8",
			input: `<html><head><title>no declaration</title></head></html>`,
			want:  "utf-8",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := dataeng.Resolve("", []byte(test.input), true)
			if decision.Undecided {
				t.Fatalf("unexpected undecided decision: %+v", decision)
			}
			if decision.Charset != test.want {
				t.Fatalf("charset = %q, want %q (decision %+v)", decision.Charset, test.want, decision)
			}
			if test.want == "utf-8" && test.name == "fallback is UTF-8" {
				if decision.Source != "default" {
					t.Fatalf("source = %q, want default", decision.Source)
				}
			}
		})
	}
}

func TestMetaIsLimitedToFirst1024Bytes(t *testing.T) {
	sample := append(
		[]byte(strings.Repeat("a", dataeng.SniffLimit)),
		[]byte(`<meta charset="windows-1252">`)...,
	)
	decision := dataeng.Resolve("", sample, false)
	if decision.Charset != "utf-8" || decision.Source != "default" {
		t.Fatalf("decision = %+v, want UTF-8 default", decision)
	}
}

func TestMetaCutAtSniffLimitIsUndecided(t *testing.T) {
	sample := append(
		[]byte(strings.Repeat("a", dataeng.SniffLimit-10)),
		[]byte(`<meta charset="windows-1252">`)...,
	)
	if len(sample) > dataeng.SniffLimit {
		sample = sample[:dataeng.SniffLimit]
	}
	decision := dataeng.Resolve("", sample, false)
	if !decision.Undecided || decision.Source != "undecided" {
		t.Fatalf("decision = %+v, want undecided", decision)
	}
}

func TestMetaEndingAtSniffLimitIsFound(t *testing.T) {
	const declaration = `<meta charset="windows-1252">`
	sample := append(
		[]byte(strings.Repeat("a", dataeng.SniffLimit-len(declaration))),
		[]byte(declaration)...,
	)
	if len(sample) != dataeng.SniffLimit {
		t.Fatalf("sample length = %d", len(sample))
	}
	decision := dataeng.Resolve("", sample, false)
	if decision.Charset != "windows-1252" || decision.Source != "meta" {
		t.Fatalf("decision = %+v, want meta charset", decision)
	}
}

func TestCompleteBOMOrTransportAvoidsTruncatedMeta(t *testing.T) {
	truncatedMeta := []byte(`<meta charset="gb`)

	decision := dataeng.Resolve("windows-1252", truncatedMeta, false)
	if decision.Undecided || decision.Charset != "windows-1252" || decision.Source != "transport" {
		t.Fatalf("transport decision = %+v", decision)
	}

	body := append([]byte{0xEF, 0xBB, 0xBF}, truncatedMeta...)
	decision = dataeng.Resolve("", body, false)
	if decision.Undecided || decision.Charset != "utf-8" || decision.Source != "bom" {
		t.Fatalf("BOM decision = %+v", decision)
	}
}

func TestPartialBOMIsTruncatedOnlyInIncompleteSample(t *testing.T) {
	for _, sample := range [][]byte{
		{0xEF, 0xBB},
		{0xFF},
		{0xFE},
	} {
		decision := dataeng.Resolve("", sample, false)
		if !decision.Undecided || decision.Source != "undecided" {
			t.Fatalf("sample %x: decision = %+v, want undecided", sample, decision)
		}
	}
}

func TestTruncatedBOMAndMeta(t *testing.T) {
	tests := []struct {
		name        string
		transport   string
		sample      []byte
		complete    bool
		undecided   bool
		wantCharset string
		wantSource  dataeng.Source
	}{
		{"partial UTF-8 BOM one byte", "", []byte{0xEF}, false, true, "", "undecided"},
		{"partial UTF-8 BOM two bytes", "", []byte{0xEF, 0xBB}, false, true, "", "undecided"},
		{"partial UTF-16LE BOM", "", []byte{0xFF}, false, true, "", "undecided"},
		{"partial UTF-16BE BOM", "", []byte{0xFE}, false, true, "", "undecided"},
		{"partial BOM beats transport", "windows-1252", []byte{0xFF}, false, true, "", "undecided"},
		{"complete single byte is not a BOM", "", []byte{0xEF}, true, false, "utf-8", "default"},
		{"incomplete meta value", "", []byte(`<meta charset="gb`), false, true, "", "undecided"},
		{"incomplete meta tag", "", []byte(`<meta charset="gbk"`), false, true, "", "undecided"},
		{"incomplete meta name", "", []byte(`<me`), false, true, "", "undecided"},
		{"complete meta tag", "", []byte(`<meta charset="gbk">`), false, false, "gbk", "meta"},
		{"unclosed meta tag in complete body", "", []byte(`<meta charset="gbk"`), true, false, "utf-8", "default"},
		{"meta hidden by unclosed script", "", []byte(`<script><meta charset=windows-1252>`), false, false, "utf-8", "default"},
		{"plain incomplete text", "", []byte("hello"), false, false, "utf-8", "default"},
		{"empty incomplete sample", "", nil, false, false, "utf-8", "default"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := dataeng.Resolve(test.transport, test.sample, test.complete)
			if decision.Undecided != test.undecided {
				t.Fatalf("decision = %+v, undecided = %v, want %v", decision, decision.Undecided, test.undecided)
			}
			if test.undecided {
				if decision.Charset != "" || decision.Source != "undecided" || decision.Decided {
					t.Fatalf("undecided decision = %+v", decision)
				}
				return
			}
			if decision.Charset != test.wantCharset || decision.Source != test.wantSource {
				t.Fatalf("decision = %+v, want charset %q source %q", decision, test.wantCharset, test.wantSource)
			}
		})
	}
}

func TestUTF32BOMIsNotAccepted(t *testing.T) {
	for _, sample := range [][]byte{
		{0xFF, 0xFE, 0x00, 0x00},
		{0x00, 0x00, 0xFE, 0xFF},
	} {
		decision := dataeng.Resolve("", sample, true)
		if decision.HasBOM || decision.BOMLen != 0 || decision.Charset != "utf-8" {
			t.Fatalf("UTF-32 BOM decision = %+v, want no recognized BOM", decision)
		}
	}
}
