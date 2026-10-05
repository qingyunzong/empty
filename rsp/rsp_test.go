package rsp

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func texts(tokens []Token) []string {
	out := make([]string, len(tokens))
	for i, t := range tokens {
		out[i] = t.Text
	}
	return out
}

func TestRecursiveExpansion(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/a.rsp": "-x @b.rsp",
		"/b.rsp": "-y @c.rsp",
		"/c.rsp": "-z",
	}}
	got, err := Expand(fs, []string{"-top", "@a.rsp", "-tail"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"-top", "-x", "-y", "-z", "-tail"}
	if !reflect.DeepEqual(texts(got), want) {
		t.Fatalf("got %v, want %v", texts(got), want)
	}
}

func TestQuotesAndEscapes(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/q.rsp": `"a b" 'c d' e\ f "g\"h" 'i\j' "k\tab	l" pre"mid"post`,
	}}
	got, err := Expand(fs, []string{"@q.rsp"})
	if err != nil {
		t.Fatal(err)
	}
	// Inside double quotes a backslash escapes the next character
	// literally, so \t becomes "t"; the raw TAB is preserved as-is.
	want := []string{"a b", "c d", "e f", `g"h`, `i\j`, "ktab\tl", "premidpost"}
	if !reflect.DeepEqual(texts(got), want) {
		t.Fatalf("got %q, want %q", texts(got), want)
	}
}

func TestUnterminatedQuote(t *testing.T) {
	fs := MapFS{Files: map[string]string{"/u.rsp": `"oops`}}
	if _, err := Expand(fs, []string{"@u.rsp"}); err == nil {
		t.Fatal("expected error for unterminated quote")
	}
}

func TestRelativeToIncludingFile(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/proj/main.rsp":          "@sub/flags.rsp",
		"/proj/sub/flags.rsp":     "@deep/more.rsp",
		"/proj/sub/deep/more.rsp": "leaf",
	}}
	got, err := Expand(fs, []string{"@/proj/main.rsp"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"leaf"}; !reflect.DeepEqual(texts(got), want) {
		t.Fatalf("got %v, want %v", texts(got), want)
	}
	if got[0].Source.File != "/proj/sub/deep/more.rsp" {
		t.Fatalf("source file = %q", got[0].Source.File)
	}
}

func TestCycleReportsCanonicalChain(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/x/../a.rsp": "",
		"/a.rsp":      "@b.rsp",
		"/b.rsp":      "@./a.rsp",
	}}
	_, err := Expand(fs, []string{"@a.rsp"})
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	want := []string{"/a.rsp", "/b.rsp", "/a.rsp"}
	if !reflect.DeepEqual(cyc.Chain, want) {
		t.Fatalf("chain = %v, want %v", cyc.Chain, want)
	}
	if msg := cyc.Error(); msg != "response file cycle: /a.rsp -> /b.rsp -> /a.rsp" {
		t.Fatalf("message = %q", msg)
	}
}

func TestDoubleDashAffectsWholeExpandedSequence(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/f.rsp": "-- @g.rsp",
		"/g.rsp": "pos1",
	}}
	// Expansion happens before "--" splitting, so @g.rsp after "--" is
	// still expanded, and "--" inside f.rsp terminates options for the
	// entire flattened sequence, including tokens from the command line.
	got, err := Parse(fs, []string{"-opt", "@f.rsp", "-after"})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Terminated {
		t.Fatal("expected Terminated")
	}
	if want := []string{"-opt"}; !reflect.DeepEqual(texts(got.Options), want) {
		t.Fatalf("options = %v, want %v", texts(got.Options), want)
	}
	if want := []string{"pos1", "-after"}; !reflect.DeepEqual(texts(got.Positional), want) {
		t.Fatalf("positional = %v, want %v", texts(got.Positional), want)
	}
}

func TestNoDoubleDash(t *testing.T) {
	got, err := Parse(MapFS{}, []string{"-a", "-b"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Terminated || len(got.Positional) != 0 || len(got.Options) != 2 {
		t.Fatalf("unexpected %+v", got)
	}
}

func TestSourceSpans(t *testing.T) {
	content := "alpha  \"beta gamma\"\tdelta"
	fs := MapFS{Files: map[string]string{"/s.rsp": content}}
	got, err := Expand(fs, []string{"-cli", "@s.rsp"})
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Source.File != "" {
		t.Fatalf("command-line token should have empty source, got %+v", got[0].Source)
	}
	for _, tok := range got[1:] {
		if tok.Source.File != "/s.rsp" {
			t.Fatalf("token %q from %q", tok.Text, tok.Source.File)
		}
		raw := content[tok.Source.Start:tok.Source.End]
		if raw != "alpha" && raw != `"beta gamma"` && raw != "delta" {
			t.Fatalf("token %q span %d:%d = %q", tok.Text, tok.Source.Start, tok.Source.End, raw)
		}
	}
	// Exact offsets: "alpha" at 0:5, quoted token at 7:19, "delta" at 20:25.
	if got[1].Source.Start != 0 || got[1].Source.End != 5 {
		t.Fatalf("alpha span = %+v", got[1].Source)
	}
	if got[2].Source.Start != 7 || got[2].Source.End != 19 {
		t.Fatalf("quoted span = %+v", got[2].Source)
	}
	if got[3].Source.Start != 20 || got[3].Source.End != 25 {
		t.Fatalf("delta span = %+v", got[3].Source)
	}
}

func TestDiamondIncludes(t *testing.T) {
	fs := MapFS{Files: map[string]string{
		"/top.rsp": "@b.rsp @c.rsp",
		"/b.rsp":   "B1 @d.rsp B2",
		"/c.rsp":   "C1 @d.rsp C2",
		"/d.rsp":   "D",
	}}
	got, err := Expand(fs, []string{"@top.rsp"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"B1", "D", "B2", "C1", "D", "C2"}
	if !reflect.DeepEqual(texts(got), want) {
		t.Fatalf("got %v, want %v", texts(got), want)
	}
	// Both occurrences of D come from /d.rsp with the same span.
	for _, i := range []int{1, 4} {
		if got[i].Source.File != "/d.rsp" || got[i].Source.Start != 0 || got[i].Source.End != 1 {
			t.Fatalf("D source = %+v", got[i].Source)
		}
	}
}

func TestOSFS(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.rsp"), []byte(`-v @sub/flags.rsp -- "two words"`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "flags.rsp"), []byte("-O2"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Parse(OSFS{}, []string{"@" + filepath.Join(dir, "main.rsp"), "tail"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"-v", "-O2"}; !reflect.DeepEqual(texts(got.Options), want) {
		t.Fatalf("options = %v, want %v", texts(got.Options), want)
	}
	if want := []string{"two words", "tail"}; !reflect.DeepEqual(texts(got.Positional), want) {
		t.Fatalf("positional = %v, want %v", texts(got.Positional), want)
	}
	wantFile, _ := OSFS{}.Canonical(filepath.Join(sub, "flags.rsp"))
	if got.Options[1].Source.File != wantFile {
		t.Fatalf("source = %q, want %q", got.Options[1].Source.File, wantFile)
	}
}

func TestLiteralAtAndMissingFile(t *testing.T) {
	got, err := Expand(MapFS{}, []string{"@"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Text != "@" {
		t.Fatalf("got %v", texts(got))
	}
	if _, err := Expand(MapFS{}, []string{"@nope.rsp"}); err == nil {
		t.Fatal("expected error for missing file")
	}
}
