package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCLIEndToEnd(t *testing.T) {
	in := "4 7\n10 0 allow 1 10\n11 1 deny 5 9\n12 0 allow 3 4\n13 2 deny 7 7\n"
	var out, errOut bytes.Buffer
	code := run(&out, &errOut, strings.NewReader(in))
	if code != 0 {
		t.Fatalf("exit code %d, stderr: %s", code, errOut.String())
	}
	s := out.String()
	for _, want := range []string{
		"REJECTED", "minimal proof: 2 rule(s)", "rule ids: [10 11]",
		"exhaustive acceptance evaluated all 16 subsets",
		"no subset of size < 2 rejects",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("output missing %q:\n%s", want, s)
		}
	}
}

func TestCLIPremiseFails(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run(&out, &errOut, strings.NewReader("1 5\n1 0 allow 0 10\n"))
	if code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if !strings.Contains(out.String(), "NOT rejected") {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestCLIBadInput(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run(&out, &errOut, strings.NewReader("garbage\n"))
	if code != 2 {
		t.Fatalf("exit code %d, want 2", code)
	}
	if errOut.Len() == 0 {
		t.Fatal("expected error message on stderr")
	}
}
