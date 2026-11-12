package dataeng

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func le16(v uint16) []byte {
	return []byte{byte(v), byte(v >> 8)}
}

func le32(v uint32) []byte {
	return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
}

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func sstPayload(total, unique uint32, rest ...[]byte) []byte {
	return cat(le32(total), le32(unique), cat(rest...))
}

func stringHeader(cch uint16, flags byte, rest ...[]byte) []byte {
	return cat(le16(cch), []byte{flags}, cat(rest...))
}

func fragments(first []byte, rest ...[]byte) []Fragment {
	out := make([]Fragment, 0, 1+len(rest))
	out = append(out, NewSSTFragment(first))
	for _, data := range rest {
		out = append(out, NewContinueFragment(data))
	}
	return out
}

func TestMultipleWidthSwitchesAndUnitProvenance(t *testing.T) {
	first := sstPayload(7, 1,
		stringHeader(5, 0x01),
		[]byte{0x41, 0x00}, // A, 2-byte
	)
	input := fragments(first,
		[]byte{0x01, 0x42, 0x00}, // width 2, B
		[]byte{0x00, 0x43, 0x44}, // width 1, C D
		[]byte{0x01, 0x45, 0x00}, // width 2, E
	)

	table, err := ReadSST(input)
	if err != nil {
		t.Fatal(err)
	}
	if table.TotalReferences != 7 || table.UniqueCount != 1 || len(table.Strings) != 1 {
		t.Fatalf("unexpected table header: total=%d unique=%d strings=%d",
			table.TotalReferences, table.UniqueCount, len(table.Strings))
	}
	str := table.Strings[0]
	if str.Text != "ABCDE" {
		t.Fatalf("text = %q, want ABCDE", str.Text)
	}
	wantUnits := []Unit{
		{Value: 0x41, Fragment: 0, Offset: 11, Size: 2},
		{Value: 0x42, Fragment: 1, Offset: 1, Size: 2},
		{Value: 0x43, Fragment: 2, Offset: 1, Size: 1},
		{Value: 0x44, Fragment: 2, Offset: 2, Size: 1},
		{Value: 0x45, Fragment: 3, Offset: 1, Size: 2},
	}
	if !reflect.DeepEqual(str.Units, wantUnits) {
		t.Fatalf("units = %#v, want %#v", str.Units, wantUnits)
	}
}

func TestSingleByteUnitsAreLatin1CodePoints(t *testing.T) {
	first := sstPayload(1, 1,
		stringHeader(2, 0x00),
		[]byte{0x80, 0xFF},
	)
	table, err := ReadSST(fragments(first))
	if err != nil {
		t.Fatal(err)
	}
	if got := table.Strings[0].Text; got != "\u0080\u00ff" {
		t.Fatalf("text = %q (% x), want U+0080 U+00FF", got, []rune(got))
	}
}

func TestSurrogatePairAcrossFragments(t *testing.T) {
	first := sstPayload(1, 1,
		stringHeader(2, 0x01),
		[]byte{0x3D, 0xD8}, // high surrogate D83D
	)
	table, err := ReadSST(fragments(first,
		[]byte{0x01, 0x00, 0xDE}, // width 2, low surrogate DE00
	))
	if err != nil {
		t.Fatal(err)
	}
	str := table.Strings[0]
	if str.Text != "\U0001F600" {
		t.Fatalf("text = %q, want emoji", str.Text)
	}
	want := []Unit{
		{Value: 0xD83D, Fragment: 0, Offset: 11, Size: 2},
		{Value: 0xDE00, Fragment: 1, Offset: 1, Size: 2},
	}
	if !reflect.DeepEqual(str.Units, want) {
		t.Fatalf("units = %#v, want %#v", str.Units, want)
	}
}

func TestWidthSwitchRevealsInvalidSurrogate(t *testing.T) {
	first := sstPayload(1, 1,
		stringHeader(2, 0x01),
		[]byte{0x00, 0xD8}, // high surrogate D800
	)
	_, err := ReadSST(fragments(first,
		[]byte{0x00, 0x41}, // width 0, ASCII A is not a low surrogate
	))
	if err == nil || !strings.Contains(err.Error(), "surrogate") {
		t.Fatalf("err = %v, want surrogate validation error", err)
	}
}

func TestLoneSurrogatesRejected(t *testing.T) {
	tests := []struct {
		name string
		unit []byte
	}{
		{name: "high", unit: []byte{0x00, 0xD8}},
		{name: "low", unit: []byte{0x00, 0xDC}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			first := sstPayload(1, 1,
				stringHeader(1, 0x01),
				tc.unit,
			)
			_, err := ReadSST(fragments(first))
			if err == nil || !strings.Contains(err.Error(), "surrogate") {
				t.Fatalf("err = %v, want surrogate validation error", err)
			}
		})
	}
}

func TestZeroLengthStringFollowedByNextHeader(t *testing.T) {
	first := sstPayload(10, 2,
		stringHeader(0, 0x00),
	)
	table, err := ReadSST(fragments(first,
		cat(stringHeader(1, 0x00), []byte{0x5A}),
	))
	if err != nil {
		t.Fatal(err)
	}
	if table.TotalReferences != 10 || len(table.Strings) != 2 {
		t.Fatalf("total=%d strings=%d, want total 10 and 2 strings",
			table.TotalReferences, len(table.Strings))
	}
	if table.Strings[0].Text != "" || table.Strings[1].Text != "Z" {
		t.Fatalf("texts = %q, %q; want empty, Z", table.Strings[0].Text, table.Strings[1].Text)
	}
	want := []Unit{{Value: 'Z', Fragment: 1, Offset: 3, Size: 1}}
	if !reflect.DeepEqual(table.Strings[1].Units, want) {
		t.Fatalf("units = %#v, want %#v", table.Strings[1].Units, want)
	}
}

func TestCharacterContinuationAfterHeaderAtFragmentEnd(t *testing.T) {
	first := sstPayload(1, 1,
		stringHeader(1, 0x01),
	)
	table, err := ReadSST(fragments(first,
		[]byte{0x00, 0x41}, // width marker 0, then A
	))
	if err != nil {
		t.Fatal(err)
	}
	if got := table.Strings[0].Text; got != "A" {
		t.Fatalf("text = %q, want A", got)
	}
}

func TestCharacterContinuationMarkerErrors(t *testing.T) {
	t.Run("missing marker", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(1, 0x01),
		)
		_, err := ReadSST(fragments(first,
			[]byte{0x41}, // A without the required width marker
		))
		if err == nil || !strings.Contains(err.Error(), "character continuation") {
			t.Fatalf("err = %v, want missing width marker error", err)
		}
	})

	t.Run("invalid marker", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(2, 0x00),
			[]byte{0x41},
		)
		_, err := ReadSST(fragments(first,
			[]byte{0x02, 0x42},
		))
		if err == nil || !strings.Contains(err.Error(), "0x02") {
			t.Fatalf("err = %v, want invalid width marker error", err)
		}
	})

	t.Run("marker only", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(2, 0x00),
			[]byte{0x41},
		)
		_, err := ReadSST(fragments(first,
			[]byte{0x01},
		))
		if err == nil || !strings.Contains(err.Error(), "only a width marker") {
			t.Fatalf("err = %v, want marker-only error", err)
		}
	})

	t.Run("double-byte truncated inside fragment", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(1, 0x01),
			[]byte{0x41},
		)
		_, err := ReadSST(fragments(first,
			[]byte{0x01, 0x00, 0x42},
		))
		if err == nil || !strings.Contains(err.Error(), "truncated") {
			t.Fatalf("err = %v, want truncated unit error", err)
		}
	})

	t.Run("double-byte truncated after marker", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(2, 0x00),
			[]byte{0x41},
		)
		_, err := ReadSST(fragments(first,
			[]byte{0x01, 0x42},
		))
		if err == nil || !strings.Contains(err.Error(), "truncated") {
			t.Fatalf("err = %v, want truncated unit error", err)
		}
	})
}

func TestRunBytesSpanFragmentsWithoutWidthMarker(t *testing.T) {
	first := sstPayload(5, 1,
		stringHeader(2, 0x08, le16(1)),
		[]byte{0x41, 0x42},
	)
	table, err := ReadSST(fragments(first,
		[]byte{0x00, 0x00}, // first half of run: start 0
		[]byte{0x01, 0x00}, // second half: font 1
	))
	if err != nil {
		t.Fatal(err)
	}
	str := table.Strings[0]
	if str.Text != "AB" {
		t.Fatalf("text = %q, want AB", str.Text)
	}
	wantRuns := []Run{{Start: 0, Font: 1}}
	if !reflect.DeepEqual(str.Runs, wantRuns) {
		t.Fatalf("runs = %#v, want %#v", str.Runs, wantRuns)
	}
}

func TestRunValidation(t *testing.T) {
	tests := []struct {
		name   string
		cch    uint16
		flags  byte
		chars  []byte
		cRun   uint16
		runRaw []byte
		want   string
	}{
		{
			name: "first run not zero", cch: 2, flags: 0x08, chars: []byte{0x41, 0x42},
			cRun: 1, runRaw: cat(le16(1), le16(0)), want: "first run",
		},
		{
			name: "positions not increasing", cch: 3, flags: 0x08, chars: []byte{0x41, 0x42, 0x43},
			cRun: 2, runRaw: cat(le16(0), le16(1), le16(0), le16(2)), want: "strictly increase",
		},
		{
			name: "position equals cch", cch: 2, flags: 0x08, chars: []byte{0x41, 0x42},
			cRun: 2, runRaw: cat(le16(0), le16(1), le16(2), le16(2)), want: "less than cch",
		},
		{
			name: "more runs than units", cch: 2, flags: 0x08, chars: []byte{0x41, 0x42},
			cRun: 3, runRaw: cat(le16(0), le16(1), le16(1), le16(2), le16(2), le16(3)),
			want: "run count",
		},
		{
			name: "position cuts surrogate pair", cch: 2, flags: 0x09,
			chars: []byte{0x3D, 0xD8, 0x00, 0xDE},
			cRun:  2, runRaw: cat(le16(0), le16(1), le16(1), le16(2)),
			want: "surrogate pair",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			first := sstPayload(1, 1,
				stringHeader(tc.cch, tc.flags, le16(tc.cRun)),
				tc.chars,
				tc.runRaw,
			)
			_, err := ReadSST(fragments(first))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want error containing %q", err, tc.want)
			}
		})
	}

	t.Run("runs with zero cch", func(t *testing.T) {
		first := sstPayload(1, 1,
			stringHeader(0, 0x08, le16(1)),
		)
		_, err := ReadSST(fragments(first))
		if err == nil || !strings.Contains(err.Error(), "requires cch") {
			t.Fatalf("err = %v, want cch>0 error", err)
		}
	})
}

func TestExtendedTailContinuationDoesNotReadWidthMarker(t *testing.T) {
	for _, firstExtByte := range []byte{0x00, 0x01} {
		t.Run(fmt.Sprintf("first byte %#x", firstExtByte), func(t *testing.T) {
			first := sstPayload(3, 1,
				stringHeader(1, 0x04, le32(3)),
				[]byte{0x41},
			)
			table, err := ReadSST(fragments(first,
				[]byte{firstExtByte, 0x99},
				[]byte{0x01},
			))
			if err != nil {
				t.Fatal(err)
			}
			str := table.Strings[0]
			if str.Text != "A" {
				t.Fatalf("text = %q, want A", str.Text)
			}
			wantExt := []byte{firstExtByte, 0x99, 0x01}
			if !reflect.DeepEqual(str.Ext, wantExt) {
				t.Fatalf("ext = % x, want % x", str.Ext, wantExt)
			}
		})
	}
}

func TestRichTextAndExtendedTailHeaderOrder(t *testing.T) {
	first := sstPayload(1, 1,
		stringHeader(2, 0x0C, le16(1), le32(2)),
		[]byte{0x41, 0x42},
		cat(le16(0), le16(5)),
	)
	table, err := ReadSST(fragments(first,
		[]byte{0x00, 0x01}, // extended tail, not a width marker
	))
	if err != nil {
		t.Fatal(err)
	}
	str := table.Strings[0]
	if str.Text != "AB" {
		t.Fatalf("text = %q, want AB", str.Text)
	}
	wantRuns := []Run{{Start: 0, Font: 5}}
	if !reflect.DeepEqual(str.Runs, wantRuns) {
		t.Fatalf("runs = %#v, want %#v", str.Runs, wantRuns)
	}
	if !reflect.DeepEqual(str.Ext, []byte{0x00, 0x01}) {
		t.Fatalf("ext = % x, want 00 01", str.Ext)
	}
}

func TestStringsMayBeginInContinuationFragment(t *testing.T) {
	first := cat(le32(2), le32(1)) // SST header only
	table, err := ReadSST(fragments(first,
		cat(stringHeader(1, 0x00), []byte{'Q'}),
	))
	if err != nil {
		t.Fatal(err)
	}
	if got := table.Strings[0].Text; got != "Q" {
		t.Fatalf("text = %q, want Q", got)
	}
}

func TestEmptyUniqueTable(t *testing.T) {
	table, err := ReadSST(fragments(sstPayload(0xFFFFFFFF, 0)))
	if err != nil {
		t.Fatal(err)
	}
	if table.TotalReferences != 0xFFFFFFFF || table.UniqueCount != 0 || len(table.Strings) != 0 {
		t.Fatalf("table = %#v", table)
	}
}

func TestDeclaredCountAndInputLimits(t *testing.T) {
	tests := []struct {
		name  string
		input []Fragment
		want  string
	}{
		{
			name:  "short first fragment",
			input: fragments([]byte{0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}),
			want:  "at least 8",
		},
		{
			name:  "total below unique",
			input: fragments(cat(le32(1), le32(2))),
			want:  "less than unique",
		},
		{
			name:  "impossible unique count",
			input: fragments(cat(le32(0xFFFFFFFF), le32(0xFFFFFFFF))),
			want:  "cannot fit",
		},
		{
			name: "negative extended tail",
			input: fragments(sstPayload(1, 1,
				stringHeader(0, 0x04, le32(0x80000000)),
			)),
			want: "negative extended-tail",
		},
		{
			name: "extended tail larger than payload",
			input: fragments(sstPayload(1, 1,
				stringHeader(0, 0x04, le32(0x7FFFFFFF)),
			)),
			want: "exceeds remaining payload",
		},
		{
			name: "run bytes larger than payload",
			input: fragments(sstPayload(1, 1,
				stringHeader(1, 0x08, le16(0xFFFF)),
				[]byte{0x41},
			)),
			want: "declared run count",
		},
		{
			name: "unsupported flag bit",
			input: fragments(sstPayload(1, 1,
				stringHeader(0, 0x02),
			)),
			want: "unsupported bit",
		},
		{
			name: "empty fragment",
			input: []Fragment{
				NewSSTFragment(sstPayload(0, 0)),
				NewContinueFragment(nil),
			},
			want: "empty",
		},
		{
			name: "wrong first type",
			input: []Fragment{
				NewContinueFragment(sstPayload(0, 0)),
			},
			want: "want SST",
		},
		{
			name: "wrong continuation type",
			input: []Fragment{
				NewSSTFragment(sstPayload(1, 1, stringHeader(0, 0))),
				NewSSTFragment([]byte{0x01}),
			},
			want: "want CONTINUE",
		},
		{
			name:  "trailing payload",
			input: fragments(cat(sstPayload(0, 0), []byte{0x00})),
			want:  "payload bytes remain",
		},
		{
			name: "header spans fragment",
			input: fragments(
				cat(sstPayload(1, 1), []byte{0x01, 0x00}),
				[]byte{0x00, 0x41},
			),
			want: "fixed header spans",
		},
		{
			name: "rich header spans fragment",
			input: fragments(
				cat(sstPayload(1, 1), stringHeader(1, 0x08)),
				[]byte{0x01, 0x41},
			),
			want: "fixed header spans",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			table, err := ReadSST(tc.input)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("table=%v err=%v, want error containing %q", table, err, tc.want)
			}
			if table != nil {
				t.Fatalf("partial table returned on failure: %#v", table)
			}
		})
	}
}
