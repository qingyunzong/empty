package main

import (
	"os"
	"strings"
	"testing"
)

// runCLI feeds input through the real CLI entry point and captures
// stdout, stderr, and the exit code.
func runCLI(t *testing.T, input string) (string, string, int) {
	t.Helper()
	in, err := os.CreateTemp(t.TempDir(), "in")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := in.WriteString(input); err != nil {
		t.Fatal(err)
	}
	if _, err := in.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	out, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	errf, err := os.CreateTemp(t.TempDir(), "err")
	if err != nil {
		t.Fatal(err)
	}
	code := run(os.Args, in, out, errf)
	for _, f := range []*os.File{in, out, errf} {
		if _, err := f.Seek(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	read := func(f *os.File) string {
		b := make([]byte, 1<<16)
		n, _ := f.Read(b)
		return string(b[:n])
	}
	return read(out), read(errf), code
}

func TestCLIEndToEnd(t *testing.T) {
	stdout, stderr, code := runCLI(t, "3\na 0 deny 0 4\nb 1 allow 0 10\nc 2 deny 5 5\n5\n")
	if code != 0 {
		t.Fatalf("exit code %d, stderr=%q", code, stderr)
	}
	if stdout != "1\nc\n" {
		t.Fatalf("stdout=%q, want %q", stdout, "1\nc\n")
	}
	if !strings.Contains(stderr, "verified") {
		t.Fatalf("stderr should report verification, got %q", stderr)
	}
}

func TestCLINotDenied(t *testing.T) {
	stdout, _, code := runCLI(t, "1\na 0 allow 0 10\n5\n")
	if code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if stdout != "NONE\n" {
		t.Fatalf("stdout=%q, want NONE", stdout)
	}
}

func TestCLIInvalidInput(t *testing.T) {
	if _, _, code := runCLI(t, "1\na 0 deny 5 1\n5\n"); code != 2 {
		t.Fatalf("exit code %d, want 2", code)
	}
}
