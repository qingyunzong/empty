package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCLIArgs(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"(a|b)*b", "xaabay", "zzz"}, nil, &out)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; output:\n%s", code, out.String())
	}
	want := `"xaabay": match [1:4] "aab"` + "\n  $1 [2:3] \"a\"\n" + `"zzz": no match` + "\n"
	if out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

func TestCLINoMatch(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"abc", "abd"}, nil, &out)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
}

func TestCLIStdin(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"colou?r"}, strings.NewReader("color\ncolour\ncolr\n"), &out)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3:\n%s", len(lines), out.String())
	}
	if !strings.Contains(lines[0], `match [0:5] "color"`) ||
		!strings.Contains(lines[1], `match [0:6] "colour"`) ||
		!strings.Contains(lines[2], "no match") {
		t.Fatalf("unexpected output:\n%s", out.String())
	}
}

func TestCLIBadPattern(t *testing.T) {
	var out bytes.Buffer
	if code := run([]string{"("}, nil, &out); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}
