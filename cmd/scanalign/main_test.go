package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "items.txt")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunAlignsFiles(t *testing.T) {
	expected := writeFile(t, "a\nb\nc\n")
	scanned := writeFile(t, "a\nc\n")
	var out, errOut bytes.Buffer
	code := run([]string{expected, scanned}, strings.NewReader(""), &out, &errOut)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, errOut.String())
	}
	if want := "keep a\ndel b\nkeep c\n"; out.String() != want {
		t.Errorf("stdout = %q, want %q", out.String(), want)
	}
	if !strings.Contains(errOut.String(), "distance: 1 (del: 1, ins: 0)") {
		t.Errorf("stderr = %q, want distance summary", errOut.String())
	}
}

func TestRunEditsOnly(t *testing.T) {
	expected := writeFile(t, "a\nb\n")
	scanned := writeFile(t, "b\nc\n")
	var out bytes.Buffer
	code := run([]string{"-edits-only", expected, scanned}, strings.NewReader(""), &out, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	if want := "del a\nins c\n"; out.String() != want {
		t.Errorf("stdout = %q, want %q", out.String(), want)
	}
}

func TestRunReadsStdin(t *testing.T) {
	scanned := writeFile(t, "x\n")
	var out bytes.Buffer
	code := run([]string{"-", scanned}, strings.NewReader("x\ny\n"), &out, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	if want := "keep x\ndel y\n"; out.String() != want {
		t.Errorf("stdout = %q, want %q", out.String(), want)
	}
}

func TestRunUsageErrors(t *testing.T) {
	var errOut bytes.Buffer
	if code := run(nil, strings.NewReader(""), &bytes.Buffer{}, &errOut); code != 2 {
		t.Errorf("no args: exit code = %d, want 2", code)
	}
	if code := run([]string{"-", "-"}, strings.NewReader(""), &bytes.Buffer{}, &errOut); code != 2 {
		t.Errorf("double stdin: exit code = %d, want 2", code)
	}
	if code := run([]string{"/nonexistent-a", "/nonexistent-b"}, strings.NewReader(""), &bytes.Buffer{}, &errOut); code != 1 {
		t.Errorf("missing files: exit code = %d, want 1", code)
	}
}
