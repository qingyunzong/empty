package main

import (
	"strings"
	"testing"
)

func TestParseInputValid(t *testing.T) {
	in, err := ParseInput(strings.NewReader("2\nr1 0 deny 1 5\nr2 3 allow 2 4\n3\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(in.Rules) != 2 || in.Value != 3 {
		t.Fatalf("got %+v", in)
	}
	if in.Rules[0] != (Rule{ID: "r1", Layer: 0, Act: Deny, Lo: 1, Hi: 5}) {
		t.Fatalf("rule 1: %+v", in.Rules[0])
	}
	if in.Rules[1] != (Rule{ID: "r2", Layer: 3, Act: Allow, Lo: 2, Hi: 4}) {
		t.Fatalf("rule 2: %+v", in.Rules[1])
	}
}

func TestParseInputErrors(t *testing.T) {
	cases := map[string]string{
		"too many rules":  "19\n",
		"negative count":  "-1\n",
		"duplicate id":    "2\na 0 deny 1 2\na 0 deny 1 2\n1\n",
		"empty interval":  "1\na 0 deny 5 2\n1\n",
		"bad action":      "1\na 0 block 1 2\n1\n",
		"missing request": "1\na 0 deny 1 2\n",
		"non-integer":     "1\na x deny 1 2\n1\n",
		"truncated":       "2\na 0 deny 1 2\n",
	}
	for name, input := range cases {
		if _, err := ParseInput(strings.NewReader(input)); err == nil {
			t.Errorf("%s: expected error, got none", name)
		}
	}
}

func TestParseInputMaxRulesAccepted(t *testing.T) {
	var b strings.Builder
	b.WriteString("18\n")
	for i := 0; i < 18; i++ {
		b.WriteString("r" + strings.Repeat("x", i+1) + " 0 deny 0 0\n")
	}
	b.WriteString("0\n")
	in, err := ParseInput(strings.NewReader(b.String()))
	if err != nil {
		t.Fatalf("18 rules must be accepted: %v", err)
	}
	if len(in.Rules) != 18 {
		t.Fatalf("got %d rules", len(in.Rules))
	}
}
