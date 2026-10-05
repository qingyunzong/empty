package main

import (
	"bytes"
	"strings"
	"testing"
)

// Both ships are 100m on a 100m berth inside one window [1380,1620).
// Optimal: lark [1380,1440) wait 60, owl [1440,1620) wait 60 -> total 120.
const cliInput = `{
  "berth_length": 100,
  "step": 30,
  "tides": [{"start": 1380, "end": 1620}],
  "ships": [
    {"id": "owl", "length": 100, "arrival": 1380, "duration": 180},
    {"id": "lark", "length": 100, "arrival": 1320, "duration": 60}
  ]
}`

func TestCLITextOutput(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"-brute"}, strings.NewReader(cliInput), &out); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	if !strings.Contains(s, "occupy [1440, 1620)") {
		t.Fatalf("expected half-open occupancy in output:\n%s", s)
	}
	if !strings.Contains(s, "d1 03:00") {
		t.Fatalf("expected post-midnight clock rendering:\n%s", s)
	}
	if !strings.Contains(s, "total wait: 120 min") {
		t.Fatalf("expected total wait 120:\n%s", s)
	}
	if !strings.Contains(s, "cross-check: OK") {
		t.Fatalf("expected brute-force cross-check line:\n%s", s)
	}
}

func TestCLIJSONOutput(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"-json"}, strings.NewReader(cliInput), &out); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	if !strings.Contains(s, `"total_wait": 120`) {
		t.Fatalf("expected total_wait 120:\n%s", s)
	}
	if !strings.Contains(s, `"start": 1440`) || !strings.Contains(s, `"end": 1620`) {
		t.Fatalf("expected half-open bounds in JSON:\n%s", s)
	}
}

func TestCLIError(t *testing.T) {
	var out bytes.Buffer
	err := run(nil, strings.NewReader(`{"berth_length": 1, "step": 30, "tides": [], "ships": []}`), &out)
	if err == nil {
		t.Fatal("expected validation error for empty tides/ships")
	}
}
