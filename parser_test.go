package addrlst

import (
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []Address
	}{
		{
			name:  "basic split with span trimming",
			input: "  a@x ,  b@y  ",
			want: []Address{
				{Clean: "a@x", Start: 2, End: 5},
				{Clean: "b@y", Start: 9, End: 12},
			},
		},
		{
			name:  "comma inside quotes does not split",
			input: `"Doe, John" <john@x>, jane@y`,
			want: []Address{
				{Clean: `"Doe, John" <john@x>`, Start: 0, End: 20},
				{Clean: "jane@y", Start: 22, End: 28},
			},
		},
		{
			name:  "comma inside comment does not split",
			input: "a@x (note, with comma), b@y",
			want: []Address{
				{Clean: "a@x", Start: 0, End: 22},
				{Clean: "b@y", Start: 24, End: 27},
			},
		},
		{
			name:  "nested comments",
			input: "a@x (one (two (three))), b@y",
			want: []Address{
				{Clean: "a@x", Start: 0, End: 23},
				{Clean: "b@y", Start: 25, End: 28},
			},
		},
		{
			name:  "comment adjacent to atoms leaves no gap",
			input: "john(a)@x, (b)jane@y",
			want: []Address{
				{Clean: "john@x", Start: 0, End: 9},
				{Clean: "jane@y", Start: 11, End: 20},
			},
		},
		{
			name:  "comment removal preserves surrounding spaces",
			input: "a (x) b",
			want:  []Address{{Clean: "a  b", Start: 0, End: 7}},
		},
		{
			name:  "escaped quote inside quotes",
			input: `"a\"b" <x@y>, z@w`,
			want: []Address{
				{Clean: `"a\"b" <x@y>`, Start: 0, End: 12},
				{Clean: "z@w", Start: 14, End: 17},
			},
		},
		{
			name:  "escaped paren inside comment",
			input: `a@x ( \) still ), b@y`,
			want: []Address{
				{Clean: "a@x", Start: 0, End: 16},
				{Clean: "b@y", Start: 18, End: 21},
			},
		},
		{
			name:  "unclosed quote isolated to physical line end",
			input: "\"abc, def@x, g@h\nnext@y, last@z",
			want: []Address{
				{Clean: "\"abc, def@x, g@h\nnext@y", Start: 0, End: 23},
				{Clean: "last@z", Start: 25, End: 31},
			},
		},
		{
			name:  "unclosed quote ends at CR in CRLF",
			input: "\"ab\r\ncd@x",
			want:  []Address{{Clean: "\"ab\r\ncd@x", Start: 0, End: 9}},
		},
		{
			name:  "unclosed comment runs to EOF",
			input: "a@x, b@y (oops",
			want: []Address{
				{Clean: "a@x", Start: 0, End: 3},
				{Clean: "b@y", Start: 5, End: 14},
			},
		},
		{
			name:  "empty and comment-only entries are skipped",
			input: "a@x,, ,(c), b@y",
			want: []Address{
				{Clean: "a@x", Start: 0, End: 3},
				{Clean: "b@y", Start: 12, End: 15},
			},
		},
		{
			name:  "no domain validation",
			input: "not-an-address, @, !!!",
			want: []Address{
				{Clean: "not-an-address", Start: 0, End: 14},
				{Clean: "@", Start: 16, End: 17},
				{Clean: "!!!", Start: 19, End: 22},
			},
		},
		{
			name:  "empty input",
			input: "",
			want:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseString(tt.input)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("ParseString(%q) = %#v, want %#v", tt.input, got, tt.want)
			}
		})
	}
}

// TestStreamingMatchesWhole feeds the same inputs through ParseReader with
// many chunk sizes and requires results identical to a whole-input parse.
func TestStreamingMatchesWhole(t *testing.T) {
	inputs := []string{
		"",
		"a@x, b@y",
		"  a@x ,  b@y  ",
		`"Doe, John" <john@x>, jane@y`,
		"a@x (one (two (three))), b@y",
		`"a\"b" (c\)d) <x@y>, z@w`,
		"\"unclosed quote, with comma\nnext@y, third@z",
		"a@x, b@y (unclosed comment",
		"a@x,, ,(c), b@y",
		"trailing backslash in quote \"abc\\",
		"trailing backslash in comment (abc\\",
		"multi\nline (spanning\ncomment) list@x, \"multi\nline\"@y",
	}
	chunkSizes := []int{1, 2, 3, 5, 7, 13, 64, 4096}
	for _, input := range inputs {
		want := ParseString(input)
		for _, size := range chunkSizes {
			got, err := ParseReader(strings.NewReader(input), size)
			if err != nil {
				t.Fatalf("ParseReader(%q, %d) error: %v", input, size, err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("ParseReader(%q, chunk=%d) = %#v, want %#v", input, size, got, want)
			}
		}
	}
}
