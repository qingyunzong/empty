package rsp

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func expandTexts(t *testing.T, args []string, fsys FileSystem) []string {
	t.Helper()
	tokens, err := Expand(args, fsys)
	if err != nil {
		t.Fatalf("Expand(%q) failed: %v", args, err)
	}
	return Texts(tokens)
}

func TestQuotingAndEscapes(t *testing.T) {
	fsys := MapFS{
		"/f.rsp": `plain "double quoted" 'single quoted' esc\ aped "q\"q" back\\slash pre"mid"post 'a'"b"c`,
	}
	got := expandTexts(t, []string{"@/f.rsp"}, fsys)
	want := []string{
		"plain", "double quoted", "single quoted", "esc aped",
		`q"q`, `back\slash`, "premidpost", "abc",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestTokenizerErrors(t *testing.T) {
	for name, content := range map[string]string{
		"unterminated single": `'oops`,
		"unterminated double": `"oops`,
		"trailing backslash":  `oops\`,
	} {
		fsys := MapFS{"/f.rsp": content}
		if _, err := Expand([]string{"@/f.rsp"}, fsys); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestRecursiveExpansionAndRelativePaths(t *testing.T) {
	fsys := MapFS{
		"/proj/main.rsp":          "-I @sub/flags.rsp @../common.rsp",
		"/proj/sub/flags.rsp":     `@deep/more.rsp -Wall`,
		"/proj/sub/deep/more.rsp": "-O2",
		"/common.rsp":             "-std=c20",
	}
	got := expandTexts(t, []string{"@/proj/main.rsp"}, fsys)
	want := []string{"-I", "-O2", "-Wall", "-std=c20"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRelativeToCommandLineIsCwd(t *testing.T) {
	// A relative @file on the command line resolves against the working
	// directory; use MapFS with the canonical form to stay hermetic.
	fsys := MapFS{canonical("rel.rsp"): "-x"}
	got := expandTexts(t, []string{"@rel.rsp"}, fsys)
	if !reflect.DeepEqual(got, []string{"-x"}) {
		t.Fatalf("got %q", got)
	}
}

func TestCycleReportsCanonicalChain(t *testing.T) {
	fsys := MapFS{
		"/a.rsp": "@./b.rsp",
		"/b.rsp": "@../a.rsp",
	}
	_, err := Expand([]string{"@/a.rsp"}, fsys)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	want := []string{"/a.rsp", "/b.rsp", "/a.rsp"}
	if !reflect.DeepEqual(cyc.Chain, want) {
		t.Fatalf("chain = %q, want %q", cyc.Chain, want)
	}
	if msg := err.Error(); !strings.Contains(msg, "/a.rsp -> /b.rsp -> /a.rsp") {
		t.Fatalf("error message %q does not report the chain", msg)
	}
}

func TestSelfIncludeCycle(t *testing.T) {
	fsys := MapFS{"/self.rsp": "@self.rsp"}
	_, err := Expand([]string{"@/self.rsp"}, fsys)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	if !reflect.DeepEqual(cyc.Chain, []string{"/self.rsp", "/self.rsp"}) {
		t.Fatalf("chain = %q", cyc.Chain)
	}
}

func TestDiamondIncludeIsNotACycle(t *testing.T) {
	// main includes b and c; both include d. d must be expanded twice and
	// must not be reported as a cycle.
	fsys := MapFS{
		"/main.rsp": "@b.rsp @c.rsp",
		"/b.rsp":    "b1 @d.rsp b2",
		"/c.rsp":    "c1 @d.rsp c2",
		"/d.rsp":    "shared",
	}
	got := expandTexts(t, []string{"@/main.rsp"}, fsys)
	want := []string{"b1", "shared", "b2", "c1", "shared", "c2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSourceRanges(t *testing.T) {
	content := `-I "dir with space" @inner.rsp`
	fsys := MapFS{
		"/outer.rsp": content,
		"/inner.rsp": "-O3",
	}
	tokens, err := Expand([]string{"-cmd", "@/outer.rsp"}, fsys)
	if err != nil {
		t.Fatalf("Expand failed: %v", err)
	}
	if len(tokens) != 4 {
		t.Fatalf("got %d tokens: %+v", len(tokens), tokens)
	}

	// Command-line token: no file source.
	if tokens[0].Source.File != "" {
		t.Errorf("cmdline token source = %+v", tokens[0].Source)
	}
	// File tokens: range must slice back to the raw text in the file.
	// The @inner.rsp token expands to "-O3" from the inner file, so only
	// the first two file tokens keep ranges into /outer.rsp.
	raws := []string{`-I`, `"dir with space"`}
	for i, raw := range raws {
		src := tokens[i+1].Source
		if src.File != "/outer.rsp" {
			t.Errorf("token %d file = %q", i+1, src.File)
		}
		if content[src.Start:src.End] != raw {
			t.Errorf("token %d range [%d:%d] = %q, want %q",
				i+1, src.Start, src.End, content[src.Start:src.End], raw)
		}
	}
	// Nested file token keeps its own file's range.
	src := tokens[3].Source
	if src.File != "/inner.rsp" || src.Start != 0 || src.End != 3 {
		t.Errorf("nested token source = %+v", src)
	}
}

func TestDoubleDashAppliesToExpandedSequence(t *testing.T) {
	// "--" lives inside a response file; it terminates options for the
	// whole expanded sequence, including tokens from files expanded later.
	fsys := MapFS{
		"/first.rsp":  "-a -- -b",
		"/second.rsp": "-c",
	}
	tokens, err := Expand([]string{"-top", "@/first.rsp", "@/second.rsp"}, fsys)
	if err != nil {
		t.Fatalf("Expand failed: %v", err)
	}
	// Expansion itself is unaffected by "--": everything is expanded.
	if got, want := Texts(tokens), []string{"-top", "-a", "--", "-b", "-c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("expanded = %q, want %q", got, want)
	}
	options, positional := SplitOptions(tokens)
	if got, want := Texts(options), []string{"-top", "-a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("options = %q, want %q", got, want)
	}
	if got, want := Texts(positional), []string{"--", "-b", "-c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("positional = %q, want %q", got, want)
	}
}

func TestDoubleDashWithoutTerminator(t *testing.T) {
	tokens, err := Expand([]string{"-a", "-b"}, nil)
	if err != nil {
		t.Fatalf("Expand failed: %v", err)
	}
	options, positional := SplitOptions(tokens)
	if len(positional) != 0 || len(options) != 2 {
		t.Fatalf("options=%q positional=%q", Texts(options), Texts(positional))
	}
}

func TestMissingFile(t *testing.T) {
	_, err := Expand([]string{"@/nope.rsp"}, MapFS{})
	if !IsNotExist(err) {
		t.Fatalf("expected not-exist error, got %v", err)
	}
}

func TestBareAtAndNonAtPassThrough(t *testing.T) {
	got := expandTexts(t, []string{"@", "-x", "@"}, MapFS{})
	if !reflect.DeepEqual(got, []string{"@", "-x", "@"}) {
		t.Fatalf("got %q", got)
	}
}
