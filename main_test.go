package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunLeakExample(t *testing.T) {
	var buf bytes.Buffer
	code := run([]string{"-f", "examples/leak.json"}, strings.NewReader(""), &buf)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1; output:\n%s", code, buf.String())
	}
	out := buf.String()
	if !strings.Contains(out, "leaks: 1") || !strings.Contains(out, "n1:user[sql] -> n2:query[sql] -> n3:query[sql]") {
		t.Fatalf("unexpected output:\n%s", out)
	}
}

func TestRunSanitizedExample(t *testing.T) {
	var buf bytes.Buffer
	code := run([]string{"-f", "examples/sanitized.json"}, strings.NewReader(""), &buf)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; output:\n%s", code, buf.String())
	}
	if !strings.Contains(buf.String(), "no leaks found") {
		t.Fatalf("unexpected output:\n%s", buf.String())
	}
}

func TestRunBranchExample(t *testing.T) {
	var buf bytes.Buffer
	code := run([]string{"-f", "examples/branch.json"}, strings.NewReader(""), &buf)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1; output:\n%s", code, buf.String())
	}
	if !strings.Contains(buf.String(), "n2 controls [n3]") {
		t.Fatalf("expected implicit-flow report, got:\n%s", buf.String())
	}
}

func TestRunLoopExampleJSON(t *testing.T) {
	var buf bytes.Buffer
	code := run([]string{"-f", "examples/loop.json", "-json"}, strings.NewReader(""), &buf)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1; output:\n%s", code, buf.String())
	}
	var rep report
	if err := json.Unmarshal(buf.Bytes(), &rep); err != nil {
		t.Fatalf("invalid JSON report: %v\n%s", err, buf.String())
	}
	if rep.Iterations != 3 {
		t.Fatalf("iterations = %d, want 3", rep.Iterations)
	}
	if len(rep.Leaks) != 1 || rep.Leaks[0].Sink != "n4" {
		t.Fatalf("unexpected leaks: %+v", rep.Leaks)
	}
}

func TestRunStdinAndErrors(t *testing.T) {
	var buf bytes.Buffer
	code := run(nil, strings.NewReader(`{"contexts":["sql"],"entry":"n0","nodes":[{"id":"n0","kind":"entry"}]}`), &buf)
	if code != 0 || !strings.Contains(buf.String(), "no leaks found") {
		t.Fatalf("stdin run: code=%d output:\n%s", code, buf.String())
	}

	buf.Reset()
	if code := run(nil, strings.NewReader(`{bad json`), &buf); code != 2 {
		t.Fatalf("bad input: code=%d, want 2", code)
	}

	buf.Reset()
	if code := run([]string{"-f", "examples/does-not-exist.json"}, strings.NewReader(""), &buf); code != 2 {
		t.Fatalf("missing file: code=%d, want 2", code)
	}
}
