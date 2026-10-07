package logparse

import (
	"reflect"
	"testing"
)

func parseAll(t *testing.T, input string, cfg *Config) ([]Entry, []ParseError) {
	t.Helper()
	p := NewParser(cfg)
	p.Feed([]byte(input))
	p.Close()
	return p.Entries(), p.Errors()
}

func wantEntries(t *testing.T, got []Entry, want []Entry) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entries = %+v, want %+v", got, want)
	}
}

func TestBasicKeyValue(t *testing.T) {
	got, errs := parseAll(t, "a=1 b=two\n", nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "a", Value: "1", Line: 1},
		{Key: "b", Value: "two", Line: 1},
	})
}

func TestQuotedValueWithSpaces(t *testing.T) {
	got, errs := parseAll(t, `msg="hello world"`, nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{{Key: "msg", Value: "hello world", Line: 1}})
}

func TestEscapedSpaceInBareValue(t *testing.T) {
	got, errs := parseAll(t, `msg=hello\ world again=1`, nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "msg", Value: "hello world", Line: 1},
		{Key: "again", Value: "1", Line: 1},
	})
}

func TestEscapeSequences(t *testing.T) {
	got, errs := parseAll(t, `a="x\ny\tz\"q\\" b=c\ d`, nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "a", Value: "x\ny\tz\"q\\", Line: 1},
		{Key: "b", Value: "c d", Line: 1},
	})
}

func TestBareKeyIsTrue(t *testing.T) {
	got, errs := parseAll(t, "verbose debug=0\n", nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "verbose", Value: "true", Line: 1},
		{Key: "debug", Value: "0", Line: 1},
	})
}

func TestEmptyValueIsEmptyString(t *testing.T) {
	got, errs := parseAll(t, "k= next=1", nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "k", Value: "", Line: 1},
		{Key: "next", Value: "1", Line: 1},
	})
}

func TestDuplicateKeysKeepAllValuesInOrder(t *testing.T) {
	got, errs := parseAll(t, "a=1\na=2 b=9\na=3\n", nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "a", Value: "1", Line: 1},
		{Key: "a", Value: "2", Line: 2},
		{Key: "b", Value: "9", Line: 2},
		{Key: "a", Value: "3", Line: 3},
	})
	p := NewParser(nil)
	p.Feed([]byte("a=1\na=2 b=9\na=3\n"))
	p.Close()
	if got := p.Values()["a"]; !reflect.DeepEqual(got, []string{"1", "2", "3"}) {
		t.Fatalf("Values()[a] = %v", got)
	}
}

func TestBadEscapeIsolatedToPhysicalLine(t *testing.T) {
	input := "ok=1\nbad=\\q rest=2\nafter=3\n"
	got, errs := parseAll(t, input, nil)
	if len(errs) != 1 {
		t.Fatalf("errors = %v, want exactly 1", errs)
	}
	e := errs[0]
	if e.Line != 2 {
		t.Fatalf("error line = %d, want 2", e.Line)
	}
	if e.Raw != `bad=\q` {
		t.Fatalf("error raw span = %q, want %q", e.Raw, `bad=\q`)
	}
	if e.Start != 0 || e.End != 6 {
		t.Fatalf("error span = [%d,%d), want [0,6)", e.Start, e.End)
	}
	wantEntries(t, got, []Entry{
		{Key: "ok", Value: "1", Line: 1},
		{Key: "after", Value: "3", Line: 3},
	})
}

func TestBadEscapeKeepsPriorEntriesOnSameLine(t *testing.T) {
	got, errs := parseAll(t, "a=1 b=x\\\n", nil)
	if len(errs) != 1 {
		t.Fatalf("errors = %v, want exactly 1", errs)
	}
	if errs[0].Raw != `b=x\` {
		t.Fatalf("error raw span = %q, want %q", errs[0].Raw, `b=x\`)
	}
	wantEntries(t, got, []Entry{{Key: "a", Value: "1", Line: 1}})
}

func TestUnterminatedQuoteSpan(t *testing.T) {
	_, errs := parseAll(t, `k="abc def`+"\n", nil)
	if len(errs) != 1 {
		t.Fatalf("errors = %v, want exactly 1", errs)
	}
	if errs[0].Raw != `k="abc def` {
		t.Fatalf("error raw span = %q", errs[0].Raw)
	}
}

func TestCharAfterClosingQuote(t *testing.T) {
	_, errs := parseAll(t, `k="v"x`+"\n", nil)
	if len(errs) != 1 {
		t.Fatalf("errors = %v, want exactly 1", errs)
	}
	if errs[0].Raw != `k="v"x` {
		t.Fatalf("error raw span = %q", errs[0].Raw)
	}
}

func TestMissingKey(t *testing.T) {
	got, errs := parseAll(t, "=v ok=1\n", nil)
	if len(errs) != 1 {
		t.Fatalf("errors = %v, want exactly 1", errs)
	}
	if len(got) != 0 {
		t.Fatalf("entries = %+v, want none (line abandoned at first token)", got)
	}
}

func TestCRLFAndEmptyLines(t *testing.T) {
	got, errs := parseAll(t, "a=1\r\n\r\nb=2\r\n", nil)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, got, []Entry{
		{Key: "a", Value: "1", Line: 1},
		{Key: "b", Value: "2", Line: 3},
	})
}

// TestChunkedEnumeration feeds the same input split at every possible byte
// boundary (2-way and 3-way) and verifies results match one-shot parsing.
func TestChunkedEnumeration(t *testing.T) {
	cfg := NewConfig()
	mustAlias(t, cfg, "h", "host")
	input := "h=web1 msg=\"hi there\" flag\n" +
		"path=a\\ b n=1 n=2\n" +
		"bad=\\q dropped=1\n" +
		"tail=\"unterminated"
	wantE, wantErrs := parseAll(t, input, cfg)

	check := func(chunks ...string) {
		t.Helper()
		p := NewParser(cfg)
		for _, c := range chunks {
			p.Feed([]byte(c))
		}
		p.Close()
		if !reflect.DeepEqual(p.Entries(), wantE) {
			t.Fatalf("chunks %q: entries = %+v, want %+v", chunks, p.Entries(), wantE)
		}
		if !reflect.DeepEqual(p.Errors(), wantErrs) {
			t.Fatalf("chunks %q: errors = %+v, want %+v", chunks, p.Errors(), wantErrs)
		}
	}

	for i := 0; i <= len(input); i++ {
		check(input[:i], input[i:])
	}
	for i := 0; i <= len(input); i++ {
		for j := i; j <= len(input); j++ {
			check(input[:i], input[i:j], input[j:])
		}
	}
	p := NewParser(cfg)
	for k := 0; k < len(input); k++ {
		p.Feed([]byte(input[k : k+1]))
	}
	p.Close()
	if !reflect.DeepEqual(p.Entries(), wantE) || !reflect.DeepEqual(p.Errors(), wantErrs) {
		t.Fatalf("byte-at-a-time feed diverged")
	}
}

// TestHotReloadBoundary verifies that a config swap applies only to lines
// started after the swap; a line spanning the swap keeps the old rules.
func TestHotReloadBoundary(t *testing.T) {
	oldCfg := NewConfig()
	mustAlias(t, oldCfg, "h", "host")
	newCfg := NewConfig()
	mustAlias(t, newCfg, "h", "hostname")

	p := NewParser(oldCfg)
	p.Feed([]byte("h=1 k=part"))
	p.SetConfig(newCfg)
	p.Feed([]byte("ial\nh=2\n"))
	p.Close()

	if errs := p.Errors(); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	wantEntries(t, p.Entries(), []Entry{
		{Key: "host", Value: "1", Line: 1},
		{Key: "k", Value: "partial", Line: 1},
		{Key: "hostname", Value: "2", Line: 2},
	})
}

// TestHotReloadAffectsOnlyNewLines: lines fully parsed before the swap are
// untouched, and lines starting after the swap use the new config.
func TestHotReloadAffectsOnlyNewLines(t *testing.T) {
	oldCfg := NewConfig()
	mustAlias(t, oldCfg, "lvl", "level")
	newCfg := oldCfg.Clone()
	mustAlias(t, newCfg, "lvl", "severity")

	p := NewParser(oldCfg)
	p.Feed([]byte("lvl=info\n"))
	p.SetConfig(newCfg)
	p.Feed([]byte("lvl=warn\n"))
	p.Close()

	wantEntries(t, p.Entries(), []Entry{
		{Key: "level", Value: "info", Line: 1},
		{Key: "severity", Value: "warn", Line: 2},
	})
}

// TestHotReloadMidChunkBoundary swaps the config between two lines that
// arrive in a single later chunk.
func TestHotReloadMidChunkBoundary(t *testing.T) {
	oldCfg := NewConfig()
	mustAlias(t, oldCfg, "x", "old_x")
	newCfg := NewConfig()
	mustAlias(t, newCfg, "x", "new_x")

	p := NewParser(oldCfg)
	p.Feed([]byte("x=1 "))
	p.SetConfig(newCfg)
	p.Feed([]byte("y=2\nx=3\nx=4"))
	p.Close()

	wantEntries(t, p.Entries(), []Entry{
		{Key: "old_x", Value: "1", Line: 1},
		{Key: "y", Value: "2", Line: 1},
		{Key: "new_x", Value: "3", Line: 2},
		{Key: "new_x", Value: "4", Line: 3},
	})
}
