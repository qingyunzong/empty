package jsoncanon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeInput(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, "input.jsonc")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunPublishesCanonicalOutput(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, "// hi\n{\"b\": [2, 1,], \"a\": 1.50,}\n")
	out := filepath.Join(dir, "out.json")
	if err := Run(RunOptions{InputPath: in, OutputPath: out}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), `{"a":1.50,"b":[2,1]}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
}

func TestRunBadInputPublishesNothing(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.json")
	spans := filepath.Join(dir, "out.spans.json")

	bad := []string{
		`{"a": 1,`,
		`{"a": 1, "a": 2}`,
		`{"a": 1} trailing`,
		`/* unterminated`,
	}
	for i, src := range bad {
		in := writeInput(t, dir, src)
		if err := Run(RunOptions{InputPath: in, OutputPath: out, SpansPath: spans}); err == nil {
			t.Errorf("case %d: expected error", i)
		}
		if _, err := os.Stat(out); !os.IsNotExist(err) {
			t.Errorf("case %d: partial output published", i)
		}
		if _, err := os.Stat(spans); !os.IsNotExist(err) {
			t.Errorf("case %d: partial spans published", i)
		}
		if _, err := os.Stat(out + ".tmp"); !os.IsNotExist(err) {
			t.Errorf("case %d: temp output left behind", i)
		}
	}
}

func TestRunBadInputKeepsExistingOutput(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.json")
	if err := os.WriteFile(out, []byte("sentinel"), 0o644); err != nil {
		t.Fatal(err)
	}
	in := writeInput(t, dir, `{"a": 1, "a": 2}`)
	if err := Run(RunOptions{InputPath: in, OutputPath: out}); err == nil {
		t.Fatal("expected error")
	}
	data, _ := os.ReadFile(out)
	if string(data) != "sentinel" {
		t.Fatal("existing output was clobbered")
	}
}

// bigFlatJSONC builds a large flat object source that forces external sort.
func bigFlatJSONC(n int) string {
	var b strings.Builder
	b.WriteString("{")
	for i := n - 1; i >= 0; i-- {
		fmt.Fprintf(&b, `"k%04d": %d,`, i, i)
	}
	b.WriteString("}")
	return b.String()
}

func TestRunPauseAndResume(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, bigFlatJSONC(200))
	out := filepath.Join(dir, "out.json")
	state := filepath.Join(dir, "state.json")

	opts := RunOptions{
		InputPath:          in,
		OutputPath:         out,
		MemBudget:          128,
		TempDir:            filepath.Join(dir, "tmp"),
		StatePath:          state,
		PauseAfterSegments: 1,
	}
	err := Run(opts)
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("got %v, want ErrPaused", err)
	}
	if _, err := os.Stat(state); err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("output must not be published on pause")
	}

	resume := opts
	resume.Resume = true
	resume.PauseAfterSegments = 0
	if err := Run(resume); err != nil {
		t.Fatalf("resume: %v", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}

	v := mustParse(t, bigFlatJSONC(200))
	want, _, err := Canonicalize(v, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("resumed output differs from full-memory canonicalization")
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Error("state file not cleaned up after successful resume")
	}
}

func TestRunResumeRejectsChangedInput(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, bigFlatJSONC(100))
	out := filepath.Join(dir, "out.json")
	state := filepath.Join(dir, "state.json")

	opts := RunOptions{
		InputPath:          in,
		OutputPath:         out,
		MemBudget:          64,
		TempDir:            filepath.Join(dir, "tmp"),
		StatePath:          state,
		PauseAfterSegments: 1,
	}
	if err := Run(opts); !errors.Is(err, ErrPaused) {
		t.Fatalf("got %v, want ErrPaused", err)
	}

	if err := os.WriteFile(in, []byte(bigFlatJSONC(99)), 0o644); err != nil {
		t.Fatal(err)
	}
	resume := opts
	resume.Resume = true
	resume.PauseAfterSegments = 0
	err := Run(resume)
	if err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("got %v, want hash mismatch error", err)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("output must not be published after failed resume")
	}
}

func TestRunResumeRejectsChangedBudget(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, bigFlatJSONC(100))
	state := filepath.Join(dir, "state.json")
	opts := RunOptions{
		InputPath:          in,
		OutputPath:         filepath.Join(dir, "out.json"),
		MemBudget:          64,
		TempDir:            filepath.Join(dir, "tmp"),
		StatePath:          state,
		PauseAfterSegments: 1,
	}
	if err := Run(opts); !errors.Is(err, ErrPaused) {
		t.Fatalf("got %v, want ErrPaused", err)
	}
	opts.Resume = true
	opts.PauseAfterSegments = 0
	opts.MemBudget = 4096
	if err := Run(opts); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("got %v, want budget mismatch error", err)
	}
}

func TestRunSpansFile(t *testing.T) {
	dir := t.TempDir()
	src := `{"b": [1, 2], "a": "x"}`
	in := writeInput(t, dir, src)
	out := filepath.Join(dir, "out.json")
	spansPath := filepath.Join(dir, "out.spans.json")
	if err := Run(RunOptions{InputPath: in, OutputPath: out, SpansPath: spansPath}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(spansPath)
	if err != nil {
		t.Fatal(err)
	}
	var spans []SpanEntry
	if err := json.Unmarshal(data, &spans); err != nil {
		t.Fatal(err)
	}
	byPath := map[string]Span{}
	for _, se := range spans {
		byPath[se.Path] = Span{se.Start, se.End}
	}
	if sp := byPath["/a"]; src[sp.Start:sp.End] != `"x"` {
		t.Errorf(`/a span = %q`, src[sp.Start:sp.End])
	}
	if sp := byPath["/b/1"]; src[sp.Start:sp.End] != `2` {
		t.Errorf(`/b/1 span = %q`, src[sp.Start:sp.End])
	}
}
