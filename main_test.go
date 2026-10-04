package main

import (
	"strings"
	"testing"
)

func TestRunEndToEnd(t *testing.T) {
	input := `{
	  "states": ["s0", "s1"],
	  "initial": "s0",
	  "events": ["a"],
	  "transitions": [{"from": "s0", "event": "a", "to": "s1"}],
	  "bad": ["s1"],
	  "budget": 5
	}`
	var out strings.Builder
	if code := run(nil, strings.NewReader(input), &out); code != 0 {
		t.Fatalf("exit code %d, output:\n%s", code, out.String())
	}
	for _, want := range []string{"VIOLATED", "s0 -a-> s1", "layered enumeration: OK"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q:\n%s", want, out.String())
		}
	}
}

func TestRunBoundedOnly(t *testing.T) {
	// Violation needs 2 steps; budget 1 must report "holds within budget"
	// while exact safety still reports the violation.
	input := `{
	  "states": ["s0", "s1", "s2"],
	  "initial": "s0",
	  "events": ["a"],
	  "transitions": [
	    {"from": "s0", "event": "a", "to": "s1"},
	    {"from": "s1", "event": "a", "to": "s2"}
	  ],
	  "bad": ["s2"],
	  "budget": 1
	}`
	var out strings.Builder
	if code := run(nil, strings.NewReader(input), &out); code != 0 {
		t.Fatalf("exit code %d, output:\n%s", code, out.String())
	}
	for _, want := range []string{"no violation within 1 steps", "not a proof of global safety", "VIOLATED: shortest trace (2 steps)"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q:\n%s", want, out.String())
		}
	}
}

func TestRunRejectsOversizedInput(t *testing.T) {
	input := `{
	  "states": ["s0","s1","s2","s3","s4","s5","s6","s7","s8"],
	  "initial": "s0",
	  "events": ["a"]
	}`
	var out strings.Builder
	if code := run(nil, strings.NewReader(input), &out); code == 0 {
		t.Fatalf("expected non-zero exit for 9 states, output:\n%s", out.String())
	}
}

func TestRunJSONReport(t *testing.T) {
	input := `{
	  "states": ["s0", "s1", "g"],
	  "initial": "s0",
	  "events": ["a", "b"],
	  "transitions": [
	    {"from": "s0", "event": "a", "to": "s1"},
	    {"from": "s1", "event": "a", "to": "s1"},
	    {"from": "s1", "event": "b", "to": "s1"},
	    {"from": "s1", "event": "b", "to": "g"}
	  ],
	  "goal": ["g"]
	}`
	var out strings.Builder
	if code := run([]string{"-json"}, strings.NewReader(input), &out); code != 0 {
		t.Fatalf("exit code %d, output:\n%s", code, out.String())
	}
	for _, want := range []string{`"status": "fair_violation"`, `"prefix"`, `"cycle"`, `"lasso_unrolling": "OK`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("JSON report missing %s:\n%s", want, out.String())
		}
	}
}
