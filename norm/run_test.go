package norm

import (
	"bytes"
	"context"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runCLI(opts Options) (int, string) {
	var stderr bytes.Buffer
	opts.Stderr = &stderr
	return Run(context.Background(), opts), stderr.String()
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRunFileToFile(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "in.jsonc")
	out := filepath.Join(dir, "out.json")
	writeFile(t, in, "{ // c\n \"b\": [2, 1,], \"a\": 1.50, }")
	code, _ := runCLI(Options{InputPath: in, OutputPath: out})
	if code != ExitOK {
		t.Fatalf("exit code %d", code)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"a":1.5,"b":[2,1]}` {
		t.Errorf("output = %s", data)
	}
}

func TestAtomicPublishOnBadInput(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.json")
	bad := []string{
		`{"a": [1, 2, {"b": }, "c"]}`, // parse error deep in the document
		`{"x":1,"y":2,"x":3}`,         // duplicate key detected during emit
		`{"a": "unterminated`,
	}
	for i, src := range bad {
		in := filepath.Join(dir, "in.jsonc")
		writeFile(t, in, src)
		code, _ := runCLI(Options{InputPath: in, OutputPath: out, MemBudget: 16})
		if code != ExitError {
			t.Fatalf("case %d: exit code %d, want %d", i, code, ExitError)
		}
		if _, err := os.Stat(out); !os.IsNotExist(err) {
			t.Errorf("case %d: partial normalized file was published", i)
		}
		if _, err := os.Stat(out + ".part"); !os.IsNotExist(err) {
			t.Errorf("case %d: temporary output file was left behind", i)
		}
	}
}

func TestPauseAndResume(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	in := filepath.Join(dir, "in.jsonc")
	out := filepath.Join(dir, "out.json")
	rng := rand.New(rand.NewSource(77))
	src := buildWideObject(rng, 200)
	writeFile(t, in, src)

	// Pause after the first segment flush.
	code, msg := runCLI(Options{
		InputPath: in, OutputPath: out, StateDir: state,
		MemBudget: 256, PauseAfterSegments: 1,
	})
	if code != ExitPaused {
		t.Fatalf("exit code %d, want %d (%s)", code, ExitPaused, msg)
	}
	if _, err := os.Stat(filepath.Join(state, "checkpoint.json")); err != nil {
		t.Fatalf("checkpoint not written: %v", err)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("output must not be published on pause")
	}

	// Resume to completion.
	code, msg = runCLI(Options{InputPath: in, OutputPath: out, StateDir: state, MemBudget: 256})
	if code != ExitOK {
		t.Fatalf("resume: exit code %d (%s)", code, msg)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	want := mustNormalize(t, src, 1<<30)
	if string(data) != want {
		t.Fatal("resumed output differs from full-memory normalization")
	}
	// Checkpoint and segment files are cleaned up after success.
	if _, err := os.Stat(filepath.Join(state, "checkpoint.json")); !os.IsNotExist(err) {
		t.Error("checkpoint not cleaned up after successful run")
	}
	if matches, _ := filepath.Glob(filepath.Join(state, "seg-*.bin")); len(matches) != 0 {
		t.Errorf("segment files left behind: %v", matches)
	}
}

func TestResumeRejectsChangedInput(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	in := filepath.Join(dir, "in.jsonc")
	out := filepath.Join(dir, "out.json")
	rng := rand.New(rand.NewSource(78))
	src := buildWideObject(rng, 200)
	writeFile(t, in, src)

	code, _ := runCLI(Options{
		InputPath: in, OutputPath: out, StateDir: state,
		MemBudget: 256, PauseAfterSegments: 1,
	})
	if code != ExitPaused {
		t.Fatalf("exit code %d, want %d", code, ExitPaused)
	}

	// Tamper with the input: the recorded hash must reject the resume.
	writeFile(t, in, src[:len(src)-1]+`,"zzz":0}`)
	code, msg := runCLI(Options{InputPath: in, OutputPath: out, StateDir: state, MemBudget: 256})
	if code != ExitError {
		t.Fatalf("exit code %d, want %d", code, ExitError)
	}
	if !strings.Contains(msg, "input changed since checkpoint") {
		t.Errorf("error %q does not mention the input hash mismatch", msg)
	}
}

func TestResumeRejectsChangedBudget(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	in := filepath.Join(dir, "in.jsonc")
	out := filepath.Join(dir, "out.json")
	rng := rand.New(rand.NewSource(79))
	writeFile(t, in, buildWideObject(rng, 100))

	code, _ := runCLI(Options{
		InputPath: in, OutputPath: out, StateDir: state,
		MemBudget: 256, PauseAfterSegments: 1,
	})
	if code != ExitPaused {
		t.Fatalf("exit code %d, want %d", code, ExitPaused)
	}
	code, msg := runCLI(Options{InputPath: in, OutputPath: out, StateDir: state, MemBudget: 512})
	if code != ExitError || !strings.Contains(msg, "memory budget") {
		t.Fatalf("exit code %d, msg %q", code, msg)
	}
}

func TestResumeRejectsTamperedSegment(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	in := filepath.Join(dir, "in.jsonc")
	out := filepath.Join(dir, "out.json")
	rng := rand.New(rand.NewSource(80))
	writeFile(t, in, buildWideObject(rng, 100))

	code, _ := runCLI(Options{
		InputPath: in, OutputPath: out, StateDir: state,
		MemBudget: 256, PauseAfterSegments: 1,
	})
	if code != ExitPaused {
		t.Fatalf("exit code %d, want %d", code, ExitPaused)
	}
	// Corrupt a segment file; the integrity check must catch it.
	segs, _ := filepath.Glob(filepath.Join(state, "seg-*.bin"))
	if len(segs) == 0 {
		t.Fatal("no segment files written")
	}
	f, _ := os.OpenFile(segs[0], os.O_WRONLY|os.O_APPEND, 0)
	f.WriteString("x")
	f.Close()
	code, msg := runCLI(Options{InputPath: in, OutputPath: out, StateDir: state, MemBudget: 256})
	if code != ExitError || !strings.Contains(msg, "integrity check") {
		t.Fatalf("exit code %d, msg %q", code, msg)
	}
}

func TestSpansOutput(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "in.jsonc")
	spans := filepath.Join(dir, "spans.ndjson")
	src := `{"a": [10, true]}`
	writeFile(t, in, src)
	code, _ := runCLI(Options{InputPath: in, OutputPath: "-", SpansPath: spans, Stdout: &bytes.Buffer{}})
	if code != ExitOK {
		t.Fatalf("exit code %d", code)
	}
	data, err := os.ReadFile(spans)
	if err != nil {
		t.Fatal(err)
	}
	type rec struct {
		Path  string `json:"path"`
		Kind  string `json:"kind"`
		Start int    `json:"start"`
		End   int    `json:"end"`
	}
	var recs []rec
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var r rec
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("bad span line %q: %v", line, err)
		}
		recs = append(recs, r)
	}
	want := []rec{
		{"$.a[0]", "number", 7, 9},
		{"$.a[1]", "true", 11, 15},
		{"$.a", "array", 6, 16},
		{"$", "object", 0, 17},
	}
	if len(recs) != len(want) {
		t.Fatalf("got %d span records %v, want %d", len(recs), recs, len(want))
	}
	for i, w := range want {
		if recs[i] != w {
			t.Errorf("span %d = %+v, want %+v", i, recs[i], w)
		}
	}
}

func TestPauseWithoutStateDirFails(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "in.jsonc")
	rng := rand.New(rand.NewSource(81))
	writeFile(t, in, buildWideObject(rng, 100))
	code, msg := runCLI(Options{
		InputPath: in, OutputPath: "-", Stdout: &bytes.Buffer{},
		MemBudget: 128, PauseAfterSegments: 1,
	})
	if code != ExitError || !strings.Contains(msg, "state directory") {
		t.Fatalf("exit code %d, msg %q", code, msg)
	}
}
