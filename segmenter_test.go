package dataeng

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

const (
	rCR      = '\u000D'
	rLF      = '\u000A'
	rControl = '\u0001'
	rL       = '\u1100'
	rV       = '\u1161'
	rT       = '\u11A8'
	rLV      = '\uAC00'
	rLVT     = '\uAC01'
	rExtend  = '\u0301'
	rZWJ     = '\u200D'
	rSpacing = '\u0903'
	rPrepend = '\u0600'
	rRIA     = '\U0001F1E6'
	rRIB     = '\U0001F1E7'
	rRIC     = '\U0001F1E8'
	rEP1     = '\U0001F600'
	rEP2     = '\U0001F601'
)

var handmadeProperties = map[rune]Properties{
	rCR:      {Class: ClassCR},
	rLF:      {Class: ClassLF},
	rControl: {Class: ClassControl},
	rL:       {Class: ClassL},
	rV:       {Class: ClassV},
	rT:       {Class: ClassT},
	rLV:      {Class: ClassLV},
	rLVT:     {Class: ClassLVT},
	rExtend:  {Class: ClassExtend},
	rZWJ:     {Class: ClassZWJ},
	rSpacing: {Class: ClassSpacingMark},
	rPrepend: {Class: ClassPrepend},
	rRIA:     {Class: ClassRI},
	rRIB:     {Class: ClassRI},
	rRIC:     {Class: ClassRI},
	rEP1:     {Class: ClassOther, ExtendedPictographic: true},
	rEP2:     {Class: ClassOther, ExtendedPictographic: true},
}

func handmadeLookup(r rune) Properties {
	if p, ok := handmadeProperties[r]; ok {
		return p
	}
	return Properties{Class: ClassOther}
}

func TestStreamingMatchesWholeStringReference(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{name: "crlf", input: string([]rune{rCR, rLF})},
		{name: "crlf repeated", input: string([]rune{rCR, rLF, rCR, rLF})},
		{name: "controls and crlf", input: "a" + string([]rune{rCR, 'b', rLF, 'c', rCR, rLF})},
		{name: "control priority", input: string([]rune{rControl, rExtend, 'a', rControl})},
		{name: "hangul L L V T", input: string([]rune{rL, rL, rV, rT})},
		{name: "hangul LV V T", input: string([]rune{rLV, rV, rT})},
		{name: "hangul LVT T", input: string([]rune{rLVT, rT})},
		{name: "hangul mixed", input: string([]rune{rL, rLV, rV, rT})},
		{name: "hangul breaking pairs", input: string([]rune{rT, rL, 'a', rLV, rL})},
		{name: "combining marks", input: "a" + string([]rune{rExtend, rExtend}) + "b"},
		{name: "spacing mark", input: "a" + string([]rune{rSpacing}) + "b"},
		{name: "prepend chain", input: string([]rune{rPrepend, rPrepend, 'a', 'b'})},
		{name: "three regional indicators", input: string([]rune{rRIA, rRIB, rRIC})},
		{name: "five regional indicators", input: string([]rune{rRIA, rRIB, rRIC, rRIA, rRIB})},
		{name: "regional indicator restart", input: string([]rune{rRIA, rRIB, 'a', rRIA, rRIB, rRIC})},
		{name: "emoji extend zwj", input: string([]rune{rEP1, rExtend, rZWJ, rEP2})},
		{name: "emoji two extends zwj", input: string([]rune{rEP1, rExtend, rExtend, rZWJ, rEP2})},
		{name: "emoji zwj chain", input: string([]rune{rEP1, rExtend, rZWJ, rEP2, rExtend, rZWJ, rEP1})},
		{name: "zwj then other", input: string([]rune{rEP1, rZWJ, 'a', rEP2})},
		{name: "extend after zwj breaks ep", input: string([]rune{rEP1, rZWJ, rExtend, rEP2})},
		{name: "valid multibyte across chunks", input: "a" + string([]rune{rEP1, rExtend}) + "b"},
		{name: "empty", input: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			want := referenceGraphemes(tc.input, handmadeLookup)
			input := []byte(tc.input)

			for first := 0; first <= len(input); first++ {
				for second := first; second <= len(input); second++ {
					got, err := runWithCuts(input, []int{first, second}, handmadeLookup, len(input)+1)
					if err != nil {
						t.Fatalf("cuts (%d,%d): unexpected error: %v", first, second, err)
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf(
							"cuts (%d,%d):\n got: %#v\nwant: %#v",
							first, second, got, want,
						)
					}
				}
			}
		})
	}
}

func TestOneByteChunks(t *testing.T) {
	inputs := []string{
		"a" + string([]rune{rExtend, rZWJ, rEP1}),
		string([]rune{rRIA, rRIB, rRIC}),
		string([]rune{rL, rV, rT, rLF, rEP2}),
	}
	for _, input := range inputs {
		want := referenceGraphemes(input, handmadeLookup)
		var got []Grapheme
		segmenter, err := NewSegmenter(Options{
			Lookup:          handmadeLookup,
			MaxClusterBytes: len([]byte(input)) + 1,
			Emit: func(g Grapheme) error {
				got = append(got, g)
				return nil
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		for i := range []byte(input) {
			if err := segmenter.Feed([]byte(input)[i : i+1]); err != nil {
				t.Fatalf("byte %d: %v", i, err)
			}
		}
		if err := segmenter.Finish(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("input %q:\n got: %#v\nwant: %#v", input, got, want)
		}
	}
}

func TestInvalidAndTruncatedUTF8(t *testing.T) {
	tests := []struct {
		name          string
		input         []byte
		offset        int
		truncated     bool
		deliveredText []string
	}{
		{
			name:          "invalid byte after closed cluster",
			input:         []byte("ab\xFF"),
			offset:        2,
			deliveredText: []string{"a"},
		},
		{
			name:          "bad continuation after valid prefix",
			input:         []byte("a\xE2\x82b"),
			offset:        1,
			deliveredText: nil,
		},
		{
			name:          "overlong sequence",
			input:         []byte("\xE0\x80\x80"),
			offset:        0,
			deliveredText: nil,
		},
		{
			name:          "surrogate sequence",
			input:         []byte("\xED\xA0\x80"),
			offset:        0,
			deliveredText: nil,
		},
		{
			name:          "first of two invalid bytes",
			input:         []byte("a\xFF\xFE"),
			offset:        1,
			deliveredText: nil,
		},
		{
			name:          "truncated after closed cluster",
			input:         []byte("ab\xE2\x82"),
			offset:        2,
			truncated:     true,
			deliveredText: []string{"a"},
		},
		{
			name:          "truncated lead byte",
			input:         []byte("\xE2"),
			offset:        0,
			truncated:     true,
			deliveredText: nil,
		},
		{
			name:          "truncated does not seal control",
			input:         []byte("a\r\xE2\x82"),
			offset:        2,
			truncated:     true,
			deliveredText: []string{"a"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for first := 0; first <= len(tc.input); first++ {
				for second := first; second <= len(tc.input); second++ {
					got, err := runWithCuts(tc.input, []int{first, second}, handmadeLookup, len(tc.input)+1)
					if err == nil {
						t.Fatalf("cuts (%d,%d): expected error", first, second)
					}

					var encodingErr *EncodingError
					if !errors.As(err, &encodingErr) {
						t.Fatalf("cuts (%d,%d): got %T, want *EncodingError", first, second, err)
					}
					if encodingErr.Offset != tc.offset || encodingErr.Truncated != tc.truncated {
						t.Fatalf(
							"cuts (%d,%d): got offset=%d truncated=%v, want offset=%d truncated=%v",
							first, second, encodingErr.Offset, encodingErr.Truncated,
							tc.offset, tc.truncated,
						)
					}
					wantSentinel := ErrInvalidUTF8
					if tc.truncated {
						wantSentinel = ErrTruncatedUTF8
					}
					if !errors.Is(err, wantSentinel) {
						t.Fatalf("cuts (%d,%d): error %v does not wrap %v", first, second, err, wantSentinel)
					}
					if texts := graphemeTexts(got); !reflect.DeepEqual(texts, tc.deliveredText) {
						t.Fatalf(
							"cuts (%d,%d): delivered %#v, want %#v",
							first, second, texts, tc.deliveredText,
						)
					}
				}
			}
		})
	}
}

func TestCompleteSequenceAcrossChunksIsValid(t *testing.T) {
	input := []byte("a\xE2\x82\xAC\xF0\x9F\x98\x80")
	for first := 0; first <= len(input); first++ {
		for second := first; second <= len(input); second++ {
			got, err := runWithCuts(input, []int{first, second}, handmadeLookup, len(input)+1)
			if err != nil {
				t.Fatalf("cuts (%d,%d): %v", first, second, err)
			}
			// The lookup treats these non-table runes as Other, so each
			// complete code point is its own cluster.
			if len(got) != 3 {
				t.Fatalf("cuts (%d,%d): got %#v", first, second, got)
			}
		}
	}
}

func TestClusterByteLimit(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		limit     int
		wantErr   bool
		wantTexts []string
		wantCount int
	}{
		{name: "mark exceeds", input: "a" + string([]rune{rExtend}), limit: 2, wantErr: true},
		{name: "mark exactly fits", input: "a" + string([]rune{rExtend}), limit: 3, wantCount: 1},
		{name: "single rune exceeds", input: string([]rune{rEP1}), limit: 3, wantErr: true},
		{name: "single rune fits", input: string([]rune{rEP1}), limit: 4, wantCount: 1},
		{name: "separate small clusters", input: "ab", limit: 1, wantCount: 2},
		{
			name:      "break before oversized new cluster",
			input:     "a" + string([]rune{rEP1}),
			limit:     3,
			wantErr:   true,
			wantTexts: []string{"a"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			input := []byte(tc.input)
			for first := 0; first <= len(input); first++ {
				for second := first; second <= len(input); second++ {
					got, err := runWithCuts(input, []int{first, second}, handmadeLookup, tc.limit)
					if tc.wantErr {
						if !errors.Is(err, ErrClusterTooLarge) {
							t.Fatalf("cuts (%d,%d): got %v, want ErrClusterTooLarge", first, second, err)
						}
						if texts := graphemeTexts(got); !reflect.DeepEqual(texts, tc.wantTexts) {
							t.Fatalf(
								"cuts (%d,%d): delivered %#v, want %#v",
								first, second, texts, tc.wantTexts,
							)
						}
						continue
					}
					if err != nil {
						t.Fatalf("cuts (%d,%d): %v", first, second, err)
					}
					if len(got) != tc.wantCount {
						t.Fatalf("cuts (%d,%d): got %d clusters, want %d", first, second, len(got), tc.wantCount)
					}
				}
			}
		})
	}
}

func TestInvalidOptions(t *testing.T) {
	emit := func(Grapheme) error { return nil }
	tests := []struct {
		name string
		opts Options
	}{
		{name: "nil lookup", opts: Options{MaxClusterBytes: 1, Emit: emit}},
		{name: "nil emit", opts: Options{Lookup: handmadeLookup, MaxClusterBytes: 1}},
		{name: "zero limit", opts: Options{Lookup: handmadeLookup, Emit: emit}},
		{name: "negative limit", opts: Options{Lookup: handmadeLookup, MaxClusterBytes: -1, Emit: emit}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewSegmenter(tc.opts); !errors.Is(err, ErrInvalidOptions) {
				t.Fatalf("got %v, want ErrInvalidOptions", err)
			}
		})
	}
}

func TestCallbackFailureStopsDeliveryAndInput(t *testing.T) {
	sinkErr := errors.New("sink failed")
	calls := 0
	segmenter, err := NewSegmenter(Options{
		Lookup:          handmadeLookup,
		MaxClusterBytes: 8,
		Emit: func(Grapheme) error {
			calls++
			return sinkErr
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// "b" forces "a" across the boundary, so the first sink call fails.
	if err := segmenter.Feed([]byte("ab")); !errors.Is(err, sinkErr) {
		t.Fatalf("Feed error = %v, want sink error", err)
	}
	if calls != 1 {
		t.Fatalf("sink calls = %d, want 1", calls)
	}
	if err := segmenter.Feed([]byte("c")); !errors.Is(err, sinkErr) {
		t.Fatalf("second Feed error = %v, want sink error", err)
	}
	if err := segmenter.Finish(); !errors.Is(err, sinkErr) {
		t.Fatalf("Finish error = %v, want sink error", err)
	}
	if calls != 1 {
		t.Fatalf("sink called after failure: %d", calls)
	}
}

func TestFinishAndFeedAfterFinish(t *testing.T) {
	segmenter, err := NewSegmenter(Options{
		Lookup:          handmadeLookup,
		MaxClusterBytes: 4,
		Emit:            func(Grapheme) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := segmenter.Finish(); err != nil {
		t.Fatal(err)
	}
	if err := segmenter.Feed([]byte("a")); !errors.Is(err, ErrFinished) {
		t.Fatalf("Feed after Finish = %v, want ErrFinished", err)
	}
	if err := segmenter.Finish(); !errors.Is(err, ErrFinished) {
		t.Fatalf("second Finish = %v, want ErrFinished", err)
	}
}

func TestUTF16CursorSnapping(t *testing.T) {
	clusters := referenceGraphemes("a"+string(rEP1)+"b", handmadeLookup)
	cursorMap, err := NewUTF16CursorMap(clusters)
	if err != nil {
		t.Fatal(err)
	}
	if cursorMap.Length() != 4 {
		t.Fatalf("length = %d, want 4", cursorMap.Length())
	}

	// "a" is [0,1); the emoji (U+1F600) is [1,3); "b" is [3,4).
	tests := []struct {
		position  int
		wantLeft  int
		wantRight int
	}{
		{position: 0, wantLeft: 0, wantRight: 0},
		{position: 1, wantLeft: 1, wantRight: 1},
		{position: 2, wantLeft: 1, wantRight: 3}, // middle of surrogate pair
		{position: 3, wantLeft: 3, wantRight: 3},
		{position: 4, wantLeft: 4, wantRight: 4},
	}
	for _, tc := range tests {
		left, err := cursorMap.SnapLeft(tc.position)
		if err != nil || left != tc.wantLeft {
			t.Fatalf("SnapLeft(%d) = %d, %v; want %d", tc.position, left, err, tc.wantLeft)
		}
		right, err := cursorMap.SnapRight(tc.position)
		if err != nil || right != tc.wantRight {
			t.Fatalf("SnapRight(%d) = %d, %v; want %d", tc.position, right, err, tc.wantRight)
		}
	}

	combined := referenceGraphemes("a"+string(rExtend), handmadeLookup)
	if len(combined) != 1 || combined[0].UTF16End != 2 {
		t.Fatalf("unexpected combined clusters: %#v", combined)
	}
	if got, err := SnapLeftUTF16(combined, 1); err != nil || got != 0 {
		t.Fatalf("SnapLeftUTF16 = %d, %v; want 0", got, err)
	}
	if got, err := SnapRightUTF16(combined, 1); err != nil || got != 2 {
		t.Fatalf("SnapRightUTF16 = %d, %v; want 2", got, err)
	}
}

func TestUTF16CursorOutOfRange(t *testing.T) {
	cursorMap, err := NewUTF16CursorMap(referenceGraphemes("a", handmadeLookup))
	if err != nil {
		t.Fatal(err)
	}
	for _, position := range []int{-1, 2} {
		_, err := cursorMap.SnapLeft(position)
		var rangeErr *CursorRangeError
		if !errors.As(err, &rangeErr) || !errors.Is(err, ErrCursorOutOfRange) {
			t.Fatalf("SnapLeft(%d) error = %v, want CursorRangeError", position, err)
		}
		if rangeErr.Position != position || rangeErr.Length != 1 {
			t.Fatalf("range error = %#v", rangeErr)
		}
		if _, err := cursorMap.SnapRight(position); !errors.Is(err, ErrCursorOutOfRange) {
			t.Fatalf("SnapRight(%d) error = %v", position, err)
		}
	}

	empty, err := NewUTF16CursorMap(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := empty.SnapLeft(0); err != nil || got != 0 {
		t.Fatalf("empty SnapLeft = %d, %v", got, err)
	}
}

func TestUTF16CursorMapRejectsInvalidSegmentation(t *testing.T) {
	valid := Grapheme{
		ByteStart: 0, ByteEnd: 4,
		UTF16Start: 0, UTF16End: 2,
		Text: string(rEP1),
	}
	tests := []struct {
		name     string
		clusters []Grapheme
	}{
		{
			name: "byte gap",
			clusters: []Grapheme{
				valid,
				{ByteStart: 5, ByteEnd: 6, UTF16Start: 2, UTF16End: 3, Text: "a"},
			},
		},
		{
			name: "utf16 gap",
			clusters: []Grapheme{
				valid,
				{ByteStart: 4, ByteEnd: 5, UTF16Start: 3, UTF16End: 4, Text: "a"},
			},
		},
		{
			name: "text byte mismatch",
			clusters: []Grapheme{
				{ByteStart: 0, ByteEnd: 2, UTF16Start: 0, UTF16End: 1, Text: "a"},
			},
		},
		{
			name: "text width mismatch",
			clusters: []Grapheme{
				{ByteStart: 0, ByteEnd: 4, UTF16Start: 0, UTF16End: 1, Text: string(rEP1)},
			},
		},
		{
			name: "invalid text",
			clusters: []Grapheme{
				{ByteStart: 0, ByteEnd: 1, UTF16Start: 0, UTF16End: 1, Text: "\xFF"},
			},
		},
		{
			name: "empty span",
			clusters: []Grapheme{
				{ByteStart: 0, ByteEnd: 0, UTF16Start: 0, UTF16End: 0, Text: ""},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewUTF16CursorMap(tc.clusters); !errors.Is(err, ErrInvalidSegmentation) {
				t.Fatalf("got %v, want ErrInvalidSegmentation", err)
			}
		})
	}
}

// referenceGraphemes is deliberately independent of the streaming state
// machine. It evaluates the requested rule subset from the whole rune slice and
// scans backwards for the ZWJ and RI rules.
func referenceGraphemes(text string, lookup PropertyLookup) []Grapheme {
	runes := []rune(text)
	if len(runes) == 0 {
		return nil
	}
	props := make([]Properties, len(runes))
	for i, r := range runes {
		props[i] = lookup(r)
	}

	byteOffsets := make([]int, len(runes)+1)
	utf16Offsets := make([]int, len(runes)+1)
	for i, r := range runes {
		byteOffsets[i+1] = byteOffsets[i] + utf8.RuneLen(r)
		utf16Offsets[i+1] = utf16Offsets[i] + referenceUTF16Units(r)
	}

	var result []Grapheme
	clusterStart := 0
	for i := 1; i < len(runes); i++ {
		if referenceBreakBefore(runes, props, i) {
			result = append(result, Grapheme{
				ByteStart:  byteOffsets[clusterStart],
				ByteEnd:    byteOffsets[i],
				UTF16Start: utf16Offsets[clusterStart],
				UTF16End:   utf16Offsets[i],
				Text:       string(runes[clusterStart:i]),
			})
			clusterStart = i
		}
	}
	result = append(result, Grapheme{
		ByteStart:  byteOffsets[clusterStart],
		ByteEnd:    byteOffsets[len(runes)],
		UTF16Start: utf16Offsets[clusterStart],
		UTF16End:   utf16Offsets[len(runes)],
		Text:       string(runes[clusterStart:]),
	})
	return result
}

func referenceBreakBefore(runes []rune, props []Properties, i int) bool {
	prev := props[i-1]
	curr := props[i]

	if prev.Class == ClassCR && curr.Class == ClassLF {
		return false
	}
	prevControl := prev.Class == ClassControl || prev.Class == ClassCR || prev.Class == ClassLF
	currControl := curr.Class == ClassControl || curr.Class == ClassCR || curr.Class == ClassLF
	if prevControl || currControl {
		return true
	}
	if referenceHangulNoBreak(prev.Class, curr.Class) {
		return false
	}
	if curr.Class == ClassExtend || curr.Class == ClassZWJ || curr.Class == ClassSpacingMark {
		return false
	}
	if prev.Class == ClassPrepend {
		return false
	}
	if prev.Class == ClassZWJ && curr.ExtendedPictographic {
		j := i - 2
		for j >= 0 && props[j].Class == ClassExtend {
			j--
		}
		if j >= 0 && props[j].ExtendedPictographic {
			return false
		}
	}
	if prev.Class == ClassRI && curr.Class == ClassRI {
		count := 0
		for j := i - 1; j >= 0 && props[j].Class == ClassRI; j-- {
			count++
		}
		if count%2 == 1 {
			return false
		}
	}
	return true
}

func referenceHangulNoBreak(prev, curr Class) bool {
	switch prev {
	case ClassL:
		return curr == ClassL || curr == ClassV || curr == ClassLV || curr == ClassLVT
	case ClassLV, ClassV:
		return curr == ClassV || curr == ClassT
	case ClassLVT, ClassT:
		return curr == ClassT
	default:
		return false
	}
}

func referenceUTF16Units(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

func runWithCuts(input []byte, cuts []int, lookup PropertyLookup, maxBytes int) ([]Grapheme, error) {
	var delivered []Grapheme
	segmenter, err := NewSegmenter(Options{
		Lookup:          lookup,
		MaxClusterBytes: maxBytes,
		Emit: func(g Grapheme) error {
			delivered = append(delivered, g)
			return nil
		},
	})
	if err != nil {
		return nil, err
	}

	last := 0
	for _, cut := range cuts {
		if cut > len(input) || cut < last {
			return nil, errors.New("invalid test cut")
		}
		if err := segmenter.Feed(input[last:cut]); err != nil {
			return delivered, err
		}
		last = cut
	}
	if last < len(input) {
		if err := segmenter.Feed(input[last:]); err != nil {
			return delivered, err
		}
	}
	if err := segmenter.Finish(); err != nil {
		return delivered, err
	}
	return delivered, nil
}

func graphemeTexts(clusters []Grapheme) []string {
	if len(clusters) == 0 {
		return nil
	}
	texts := make([]string, len(clusters))
	for i, cluster := range clusters {
		texts[i] = cluster.Text
	}
	return texts
}

func TestDocumentedSubsetExamples(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{
			input: "a" + string([]rune{rExtend, rExtend}),
			want:  []string{"a" + string([]rune{rExtend, rExtend})},
		},
		{
			input: string([]rune{rRIA, rRIB, rRIC}),
			want:  []string{string([]rune{rRIA, rRIB}), string([]rune{rRIC})},
		},
		{
			input: string([]rune{rRIA, rRIB, rRIC, rRIA, rRIB}),
			want: []string{
				string([]rune{rRIA, rRIB}),
				string([]rune{rRIC, rRIA}),
				string([]rune{rRIB}),
			},
		},
		{
			input: string([]rune{rEP1, rExtend, rZWJ, rEP2}),
			want:  []string{string([]rune{rEP1, rExtend, rZWJ, rEP2})},
		},
		{
			input: string([]rune{rCR, rLF}),
			want:  []string{string([]rune{rCR, rLF})},
		},
	}

	for _, tc := range tests {
		got, err := runWithCuts([]byte(tc.input), nil, handmadeLookup, len([]byte(tc.input))+1)
		if err != nil {
			t.Fatalf("input %q: %v", tc.input, err)
		}
		texts := graphemeTexts(got)
		if !reflect.DeepEqual(texts, tc.want) {
			t.Fatalf("input %q:\n got: %q\nwant: %q", tc.input, texts, tc.want)
		}
	}
}

func TestClassStringNames(t *testing.T) {
	names := []string{
		ClassCR.String(),
		ClassLF.String(),
		ClassControl.String(),
		ClassL.String(),
		ClassV.String(),
		ClassT.String(),
		ClassLV.String(),
		ClassLVT.String(),
		ClassExtend.String(),
		ClassZWJ.String(),
		ClassSpacingMark.String(),
		ClassPrepend.String(),
		ClassRI.String(),
		ClassOther.String(),
	}
	want := "CR,LF,Control,L,V,T,LV,LVT,Extend,ZWJ,SpacingMark,Prepend,RI,Other"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("class names = %q, want %q", got, want)
	}
}
