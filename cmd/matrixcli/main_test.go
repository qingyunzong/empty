package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCLIEndToEnd(t *testing.T) {
	in := strings.NewReader(`dims 2 2 2
setA 0 0 1
setA 0 1 2
setA 1 0 3
setA 1 1 4
setB 0 0 5
setB 0 1 6
setB 1 0 7
setB 1 1 8
snap
check
setA 0 0 10
undo
check
setA 0 0 0
show C
diff 1 0
setB 0 0 9223372036854775807
bogus
quit
`)
	var out bytes.Buffer
	if err := run(in, &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"snapshot 1",
		"ok: C matches naive triple-loop product",
		"ok: undone",
		"(0,0) = 14", // after deleting A(0,0): C(0,0) = 0*5 + 2*7
		"A(0,0): 1 -> 0",
		"rejected: matrixlib: integer overflow",
		"unknown command: bogus",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\n--- output ---\n%s", want, got)
		}
	}
}

func TestCLIDiffBetweenSnapshots(t *testing.T) {
	in := strings.NewReader(`dims 1 1 1
setA 0 0 2
setB 0 0 3
snap
setA 0 0 5
snap
diff 1 2
quit
`)
	var out bytes.Buffer
	if err := run(in, &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"A(0,0): 2 -> 5",
		"C(0,0): 6 -> 15",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q\n--- output ---\n%s", want, got)
		}
	}
}
