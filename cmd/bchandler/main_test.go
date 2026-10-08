package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSpec(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "spec.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunOK(t *testing.T) {
	path := writeSpec(t, `{
	  "length": 4,
	  "handlers": [
	    {"name": "a", "start": 0, "end": 4},
	    {"name": "b", "start": 1, "end": 3}
	  ]
	}`)
	var out bytes.Buffer
	if err := run([]string{"-insert", "2:1", path}, &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"1    op_1         b > a",
		"after inserting 1 instruction(s) at 2 (code length 5):",
		"handler b            [1,4)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\ngot:\n%s", want, got)
		}
	}
}

func TestRunRejectsCrossing(t *testing.T) {
	path := writeSpec(t, `{
	  "length": 5,
	  "handlers": [
	    {"name": "a", "start": 0, "end": 3},
	    {"name": "b", "start": 2, "end": 4}
	  ]
	}`)
	var out bytes.Buffer
	err := run([]string{path}, &out)
	if err == nil || !strings.Contains(err.Error(), "cross") {
		t.Fatalf("want crossing error, got %v", err)
	}
}

func TestRunBadArgs(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{}, &out); err == nil {
		t.Fatal("want usage error")
	}
	if err := run([]string{"-insert", "bogus", "x.json"}, &out); err == nil {
		t.Fatal("want insert flag error")
	}
}
