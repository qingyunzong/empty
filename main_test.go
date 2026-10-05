package main

import (
	"bytes"
	"strings"
	"testing"
)

func runScript(t *testing.T, script string) string {
	t.Helper()
	var out bytes.Buffer
	if err := run(strings.NewReader(script), &out); err != nil {
		t.Fatalf("run: %v\noutput:\n%s", err, out.String())
	}
	return out.String()
}

func TestCLISolveCertificate(t *testing.T) {
	out := runScript(t, `
# three tasks, one executor
add 1 0 2 10
add 2 0 2 9
add 3 1 3 8
solve
`)
	for _, want := range []string{
		"total profit: 27",
		"slot 0: task 1",
		"slot 1: task 2",
		"slot 2: task 3",
		"ok: 3 distinct slot(s)",
		"certificate profit 27 is optimal",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestCLIUndoRecompute(t *testing.T) {
	out := runScript(t, `
add 1 0 1 10
add 2 0 1 9
solve
undo 1
solve
undo
solve
`)
	parts := strings.Split(out, "== optimal schedule ==")
	if len(parts) != 4 {
		t.Fatalf("expected 3 solve outputs, got %d:\n%s", len(parts)-1, out)
	}
	if !strings.Contains(parts[1], "total profit: 10") {
		t.Errorf("first solve should keep task 1 (profit 10):\n%s", parts[1])
	}
	if !strings.Contains(parts[2], "total profit: 9") {
		t.Errorf("after undo 1, task 2 (profit 9) should win:\n%s", parts[2])
	}
	if !strings.Contains(parts[3], "total profit: 0") {
		t.Errorf("after bare undo, no tasks remain:\n%s", parts[3])
	}
}

func TestCLIVerify(t *testing.T) {
	out := runScript(t, `
add 1 0 3 7
add 2 1 2 5
add 3 0 1 6
add 4 2 4 4
verify
`)
	if !strings.Contains(out, "match: ok") {
		t.Errorf("verify should match:\n%s", out)
	}
}

func TestCLIErrors(t *testing.T) {
	for _, script := range []string{
		"add 1 0 1\n",                // missing profit
		"add x 0 1 5\n",              // bad number
		"add 1 0 1 5\nadd 1 0 2 3\n", // duplicate ID
		"remove 9\n",                 // unknown task
		"undo\n",                     // nothing to undo
		"boom\n",                     // unknown command
	} {
		var out bytes.Buffer
		if err := run(strings.NewReader(script), &out); err == nil {
			t.Errorf("script %q: expected error", script)
		}
	}
}
