package main

import (
	"bytes"
	"strings"
	"testing"
)

func runCLI(t *testing.T, input string, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, strings.NewReader(input), &stdout, &stderr)
	return code, strings.TrimSpace(stdout.String()), stderr.String()
}

func TestCLIConvert(t *testing.T) {
	code, out, errOut := runCLI(t, `[1.005, 2.5, -0, "1e3", 0.125]`, "-scale", "2")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, errOut)
	}
	want := `["100","250","0","100000","12"]`
	if out != want {
		t.Fatalf("got %s, want %s", out, want)
	}
}

func TestCLICumulative(t *testing.T) {
	// 0.005 each: cumulative scaled 0.5 -> 0, 1.0 -> 1, 1.5 -> 2
	code, out, errOut := runCLI(t, `[0.005, 0.005, 0.005]`, "-scale", "2", "-mode", "cumulative")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, errOut)
	}
	want := `["0","1","1"]`
	if out != want {
		t.Fatalf("got %s, want %s", out, want)
	}
}

func TestCLIRejectsOutOfRangeWithIndex(t *testing.T) {
	code, _, errOut := runCLI(t, `[1.5, 1e1001, 2.5, 1e-1001]`, "-scale", "2")
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(errOut, "index 1") || !strings.Contains(errOut, "index 3") {
		t.Fatalf("stderr missing offending indices: %q", errOut)
	}
	if strings.Contains(errOut, "index 0") || strings.Contains(errOut, "index 2") {
		t.Fatalf("stderr blames valid positions: %q", errOut)
	}
}

func TestCLIInvalidJSON(t *testing.T) {
	code, _, errOut := runCLI(t, `[1, 2,`, "-scale", "2")
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(errOut, "invalid JSON") {
		t.Fatalf("stderr: %q", errOut)
	}
}

func TestCLIBadScale(t *testing.T) {
	code, _, _ := runCLI(t, `[1]`, "-scale", "1001")
	if code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
}

func TestCLIBigExponentExact(t *testing.T) {
	code, out, errOut := runCLI(t, `[1e1000]`, "-scale", "0")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, errOut)
	}
	want := `["1` + strings.Repeat("0", 1000) + `"]`
	if out != want {
		t.Fatalf("got %d-char output, want exact 10^1000", len(out))
	}
}
