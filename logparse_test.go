package logparse

import (
	"reflect"
	"testing"
)

func mustConfig(t *testing.T, aliases map[string]string) *Config {
	t.Helper()
	c, err := NewConfig(aliases)
	if err != nil {
		t.Fatalf("NewConfig(%v): %v", aliases, err)
	}
	return c
}

func TestParseBasic(t *testing.T) {
	l := Parse(`a=1 b="x y" c`, nil)
	want := []Pair{
		{Key: "a", RawKey: "a", Value: Str("1")},
		{Key: "b", RawKey: "b", Value: Str("x y")},
		{Key: "c", RawKey: "c", Value: Bool(true)},
	}
	if l.Bad {
		t.Fatalf("unexpected bad line: %+v", l)
	}
	if !reflect.DeepEqual(l.Pairs, want) {
		t.Fatalf("got %+v want %+v", l.Pairs, want)
	}
}

func TestBareKeyVsEmptyValue(t *testing.T) {
	l := Parse(`a= b`, nil)
	if got := l.Pairs[0].Value; got != Str("") {
		t.Fatalf("empty value: got %#v, want empty string", got)
	}
	if got := l.Pairs[1].Value; got != Bool(true) {
		t.Fatalf("bare key: got %#v, want true", got)
	}
}

func TestDuplicateKeysKeepOrder(t *testing.T) {
	l := Parse(`a=1 a=2 a a=`, nil)
	got := l.Values()["a"]
	want := []Value{Str("1"), Str("2"), Bool(true), Str("")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestQuotedEscapes(t *testing.T) {
	l := Parse(`a="x\ y\"z\\w\nq\="`, nil)
	want := "x y\"z\\w\nq="
	if l.Bad {
		t.Fatalf("unexpected bad line")
	}
	if got := l.Pairs[0].Value.Str; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestBareValueEscapes(t *testing.T) {
	l := Parse(`a=x\ y\\z`, nil)
	if l.Bad || l.Pairs[0].Value.Str != "x y\\z" {
		t.Fatalf("got %+v", l.Pairs[0])
	}
}

func TestBadEscapeIsolatesPhysicalLine(t *testing.T) {
	s := NewStream(nil)
	lines := s.Feed([]byte("ok=1\nbad=\"x\\q\"\nok2=2\n"))
	if len(lines) != 3 {
		t.Fatalf("got %d lines", len(lines))
	}
	if lines[0].Bad || lines[2].Bad {
		t.Fatalf("good lines must not be affected: %+v", lines)
	}
	bad := lines[1]
	if !bad.Bad {
		t.Fatalf("middle line should be bad")
	}
	if bad.Raw != `bad="x\q"` {
		t.Fatalf("raw span: got %q", bad.Raw)
	}
	if bad.Offset != 5 {
		t.Fatalf("offset: got %d want 5", bad.Offset)
	}
	if bad.Pairs != nil {
		t.Fatalf("bad line must carry no pairs: %+v", bad.Pairs)
	}
}

func TestBadLines(t *testing.T) {
	cases := []string{
		`a="x\q"`,   // invalid escape in quotes
		`a=x\`,      // trailing backslash
		`a="unterm`, // unterminated quote
		`=v`,        // empty key
		`a="x"y`,    // garbage after closing quote
	}
	for _, in := range cases {
		l := Parse(in, nil)
		if !l.Bad {
			t.Fatalf("%q should be bad", in)
		}
		if l.Raw != in {
			t.Fatalf("%q: raw span %q", in, l.Raw)
		}
	}
}

func TestAliasChainAndDedup(t *testing.T) {
	cfg := mustConfig(t, map[string]string{"x": "k", "y": "k", "a": "b", "b": "c"})
	if got := cfg.Resolve("a"); got != "c" {
		t.Fatalf("chain resolve: got %q want c", got)
	}
	l := Parse(`x=1 y=2 k=3 a=v`, cfg)
	got := l.Values()
	if want := []Value{Str("1"), Str("2"), Str("3")}; !reflect.DeepEqual(got["k"], want) {
		t.Fatalf("canonical k: got %v want %v", got["k"], want)
	}
	if want := []Value{Str("v")}; !reflect.DeepEqual(got["c"], want) {
		t.Fatalf("canonical c: got %v want %v", got["c"], want)
	}
	// RawKey still records the alias as written.
	if l.Pairs[0].RawKey != "x" || l.Pairs[0].Key != "k" {
		t.Fatalf("raw/canonical key mismatch: %+v", l.Pairs[0])
	}
}

func TestAliasCycleRejected(t *testing.T) {
	for _, aliases := range []map[string]string{
		{"a": "a"},
		{"a": "b", "b": "a"},
		{"a": "b", "b": "c", "c": "a"},
	} {
		if _, err := NewConfig(aliases); err == nil {
			t.Fatalf("cycle %v should be rejected", aliases)
		}
	}
}

// TestChunkedEnumeration exhaustively enumerates every way to split the
// input into chunks and verifies the output is identical to one-shot parsing.
func TestChunkedEnumeration(t *testing.T) {
	cfg := mustConfig(t, map[string]string{"lvl": "level"})
	input := "a=1 lvl=info\n" // 14 bytes -> 2^13 chunkings
	want := ParseText(input, cfg)
	n := len(input)
	for mask := 0; mask < 1<<(n-1); mask++ {
		s := NewStream(cfg)
		var got []Line
		prev := 0
		for i := 0; i < n-1; i++ {
			if mask&(1<<i) != 0 {
				got = append(got, s.Feed([]byte(input[prev:i+1]))...)
				prev = i + 1
			}
		}
		got = append(got, s.Feed([]byte(input[prev:]))...)
		got = append(got, s.Close()...)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("chunking %#013b: got %+v want %+v", mask, got, want)
		}
	}
}

// TestChunkedEnumerationMultiLine enumerates 1..3 chunk splits over a
// longer input containing a bad line, quoted values and escapes.
func TestChunkedEnumerationMultiLine(t *testing.T) {
	cfg := mustConfig(t, map[string]string{"x": "k"})
	input := "x=1 a=\"p q\"\nbad=\"z\\w\"\nx=2 bare\n"
	want := ParseText(input, cfg)
	n := len(input)
	splits := [][]int{{}}
	for i := 1; i < n; i++ {
		splits = append(splits, []int{i})
		for j := i + 1; j < n; j++ {
			splits = append(splits, []int{i, j})
		}
	}
	for _, sp := range splits {
		s := NewStream(cfg)
		var got []Line
		prev := 0
		for _, p := range sp {
			got = append(got, s.Feed([]byte(input[prev:p]))...)
			prev = p
		}
		got = append(got, s.Feed([]byte(input[prev:]))...)
		got = append(got, s.Close()...)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("splits %v: got %+v want %+v", sp, got, want)
		}
	}
	if len(want) != 3 || !want[1].Bad {
		t.Fatalf("sanity: %+v", want)
	}
}

// TestHotReloadMidLine: a line started before SetConfig keeps the old rules
// even though it completes afterwards.
func TestHotReloadMidLine(t *testing.T) {
	oldCfg := mustConfig(t, nil)
	newCfg := mustConfig(t, map[string]string{"a": "z"})
	s := NewStream(oldCfg)
	if got := s.Feed([]byte("a=1")); len(got) != 0 {
		t.Fatalf("no line should complete yet: %+v", got)
	}
	s.SetConfig(newCfg)
	lines := s.Feed([]byte("\na=2\n"))
	if len(lines) != 2 {
		t.Fatalf("got %d lines", len(lines))
	}
	if k := lines[0].Pairs[0].Key; k != "a" {
		t.Fatalf("line started before switch must use old rules, got key %q", k)
	}
	if k := lines[1].Pairs[0].Key; k != "z" {
		t.Fatalf("line started after switch must use new rules, got key %q", k)
	}
}

// TestHotReloadBoundary: the switch takes effect exactly at the first line
// beginning after SetConfig.
func TestHotReloadBoundary(t *testing.T) {
	oldCfg := mustConfig(t, nil)
	newCfg := mustConfig(t, map[string]string{"a": "z"})
	s := NewStream(oldCfg)
	lines := s.Feed([]byte("a=1\n"))
	if k := lines[0].Pairs[0].Key; k != "a" {
		t.Fatalf("before switch: got key %q", k)
	}
	s.SetConfig(newCfg)
	lines = s.Feed([]byte("a=2\n"))
	if k := lines[0].Pairs[0].Key; k != "z" {
		t.Fatalf("after switch: got key %q", k)
	}
	// Switch while the buffer is empty but no newline consumed yet: the next
	// line (even an empty one) uses the new config.
	s2 := NewStream(newCfg)
	s2.SetConfig(oldCfg)
	lines = s2.Feed([]byte("\n"))
	if len(lines) != 1 || lines[0].Bad || len(lines[0].Pairs) != 0 {
		t.Fatalf("empty line at boundary: %+v", lines)
	}
}

func TestTrailingUnterminatedLineFlushedOnClose(t *testing.T) {
	s := NewStream(nil)
	s.Feed([]byte("a=1\ntail=2"))
	lines := s.Close()
	if len(lines) != 1 || lines[0].Pairs[0].Key != "tail" {
		t.Fatalf("got %+v", lines)
	}
	if lines[0].Offset != 4 {
		t.Fatalf("offset: got %d want 4", lines[0].Offset)
	}
}
