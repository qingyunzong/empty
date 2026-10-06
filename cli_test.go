package main

import (
	"bytes"
	"strings"
	"testing"
)

func runCLI(t *testing.T, args []string, input string) (int, string, string) {
	t.Helper()
	var out, errBuf bytes.Buffer
	code := run(args, strings.NewReader(input), &out, &errBuf)
	return code, out.String(), errBuf.String()
}

func TestCLIFlat(t *testing.T) {
	code, out, _ := runCLI(t, []string{"-scale", "2"}, `["1.005","2.675","-0.004","1e3","-0"]`)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out) != "[100,268,0,100000,0]" {
		t.Fatalf("got %s", out)
	}
}

func TestCLINegativeZero(t *testing.T) {
	code, out, _ := runCLI(t, []string{"-scale", "2"}, `["-0.0001","-0","-0.0"]`)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out) != "[0,0,0]" {
		t.Fatalf("negative zero must print 0, got %s", out)
	}
}

func TestCLIRejectsOutOfRangeWithPosition(t *testing.T) {
	code, _, errOut := runCLI(t, []string{"-scale", "2"}, `["1.5","1e1001","2.5","1e-1001"]`)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(errOut, "index 1") || !strings.Contains(errOut, "index 3") {
		t.Fatalf("errors must carry positions, got %q", errOut)
	}
}

func TestCLICumul(t *testing.T) {
	// scale 0: 0.5,0.5,0.5 -> cumulative 0,1,2 -> deltas 0,1,1
	code, out, _ := runCLI(t, []string{"-scale", "0", "-cumul"}, `["0.5","0.5","0.5"]`)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out) != "[0,1,1]" {
		t.Fatalf("got %s", out)
	}
}

func TestCLICumulWithdraw(t *testing.T) {
	// Withdrawing row 0 of 0.5,0.5,0.5 leaves 0.5,0.5 -> deltas 0,1.
	code, out, _ := runCLI(t, []string{"-scale", "0", "-cumul", "-withdraw", "0"}, `["0.5","0.5","0.5"]`)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out) != "[0,1]" {
		t.Fatalf("got %s", out)
	}
	// Multiple withdrawals, order-independent positions.
	code, out, _ = runCLI(t, []string{"-scale", "0", "-cumul", "-withdraw", "3,1"}, `["0.4","0.4","0.4","0.4"]`)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out) != "[0,1]" {
		t.Fatalf("got %s", out)
	}
}

func TestCLICumulRejectsBadRow(t *testing.T) {
	code, _, errOut := runCLI(t, []string{"-scale", "0", "-cumul"}, `["0.5","1e1001"]`)
	if code != 1 || !strings.Contains(errOut, "index 1") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

func TestCLIInvalidJSON(t *testing.T) {
	code, _, _ := runCLI(t, nil, `not json`)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
}
