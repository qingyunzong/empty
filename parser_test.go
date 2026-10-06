package jsoncanon

import (
	"errors"
	"strings"
	"testing"
)

func mustParse(t *testing.T, src string) *Value {
	t.Helper()
	v, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return v
}
func TestParseCommentsAndTrailingCommas(t *testing.T) {
	src := `// leading comment
{
  /* block */ "a": [1, 2, 3,], // line comment
  "b": {
    "c": true,
  },
  /* multi
     line */ "d": null,
}`
	v := mustParse(t, src)
	if v.Kind != KindObject || len(v.Obj) != 3 {
		t.Fatalf("got %+v", v)
	}
	if v.Obj[0].Key != "a" || len(v.Obj[0].Value.Arr) != 3 {
		t.Fatalf("member a: %+v", v.Obj[0])
	}
	if v.Obj[2].Key != "d" || v.Obj[2].Value.Kind != KindNull {
		t.Fatalf("member d: %+v", v.Obj[2])
	}
}
func TestParseErrors(t *testing.T) {
	bad := []string{
		`{`,
		`[1,`,
		`{"a":1,,}`,
		`{,}`,
		`{"a" 1}`,
		`01`,
		`1.`,
		`-`,
		`1e`,
		`+1`,
		`.5`,
		`"unterminated`,
		"\"bad\x01ctrl\"",
		`"\x"`,
		`"\u12"`,
		`"\ud800"`,
		`"\udc00"`,
		`/* unterminated`,
		`/`,
		`true false`,
		`tru`,
		`truex`,
		`nul`,
		`{"a":1} extra`,
	}
	for _, src := range bad {
		if _, err := Parse([]byte(src)); err == nil {
			t.Errorf("Parse(%q): expected error", src)
		} else {
			var pe *ParseError
			if !errors.As(err, &pe) {
				t.Errorf("Parse(%q): error %T not *ParseError", src, err)
			}
		}
	}
}

func TestParseSpans(t *testing.T) {
	src := `{"a": [10, "xy"], "b": null}`
	v := mustParse(t, src)
	if v.Span != (Span{0, len(src)}) {
		t.Fatalf("root span %+v", v.Span)
	}
	arr := v.Obj[0].Value
	if got := src[arr.Span.Start:arr.Span.End]; got != `[10, "xy"]` {
		t.Fatalf("array span text %q", got)
	}
	num := arr.Arr[0]
	if got := src[num.Span.Start:num.Span.End]; got != "10" {
		t.Fatalf("number span text %q", got)
	}
	str := arr.Arr[1]
	if got := src[str.Span.Start:str.Span.End]; got != `"xy"` {
		t.Fatalf("string span text %q", got)
	}
}

func TestNumberLiteralPreserved(t *testing.T) {
	src := `[0, -0, 1.5, -2.75e+10, 3.14159265358979323846264338327950288419716939937510, 1e-999, 123456789012345678901234567890]`
	v := mustParse(t, src)
	want := []string{"0", "-0", "1.5", "-2.75e+10", "3.14159265358979323846264338327950288419716939937510", "1e-999", "123456789012345678901234567890"}
	for i, w := range want {
		if v.Arr[i].Num != w {
			t.Errorf("num[%d] = %q want %q", i, v.Arr[i].Num, w)
		}
	}
	if !strings.Contains(src, v.Arr[4].Num) {
		t.Errorf("literal not preserved")
	}
}
func TestParseStringEscapes(t *testing.T) {
	v := mustParse(t, `["a\nbé \ud83d\ude00\/"]`)
	s := v.Arr[0].Str
	want := "a\nbé \U0001F600/"
	if s != want {
		t.Fatalf("got %q want %q", s, want)
	}
}
