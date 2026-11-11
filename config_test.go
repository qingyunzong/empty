package q204

import (
	"errors"
	"strings"
	"testing"
)

func TestCompileRulesChoosesMostLiteralSpecificRule(t *testing.T) {
	rs, err := CompileRules([]Rule{
		{Path: []string{"a", "*", "*"}, Action: Action{Type: ActionReplace, Replacement: "one-literal"}},
		{Path: []string{"*", "b", "c"}, Action: Action{Type: ActionReplace, Replacement: "two-literals"}},
	})
	if err != nil {
		t.Fatalf("CompileRules failed: %v", err)
	}

	result, err := rs.deidentify(map[string]any{
		"a": map[string]any{"b": map[string]any{"c": "raw"}},
	}, nil)
	if err != nil {
		t.Fatalf("deidentify failed: %v", err)
	}
	got := result.(map[string]any)["a"].(map[string]any)["b"].(map[string]any)["c"]
	if got != "two-literals" {
		t.Fatalf("selected rule = %v, want the two-literal rule", got)
	}
}

func TestCompileRulesRejectsEqualSpecificityOverlap(t *testing.T) {
	_, err := CompileRules([]Rule{
		{Path: []string{"a", "*", "c"}, Action: Action{Type: ActionDelete}},
		{Path: []string{"*", "b", "c"}, Action: Action{Type: ActionHMAC}},
	})
	if err == nil {
		t.Fatal("expected ambiguous configuration to be rejected")
	}
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error = %v, want ErrInvalidConfig", err)
	}
}

func TestCompileRulesRejectsSamePathDifferentAction(t *testing.T) {
	_, err := CompileRules([]Rule{
		{Path: []string{"secret"}, Action: Action{Type: ActionDelete}},
		{Path: []string{"secret"}, Action: Action{Type: ActionHMAC}},
	})
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error = %v, want ErrInvalidConfig", err)
	}
}

func TestCompileRulesDeduplicatesIdenticalRules(t *testing.T) {
	rs, err := CompileRules([]Rule{
		{Path: []string{"secret"}, Action: Action{Type: ActionDelete}},
		{Path: []string{"secret"}, Action: Action{Type: ActionDelete, Replacement: "ignored"}},
	})
	if err != nil {
		t.Fatalf("CompileRules failed: %v", err)
	}
	result, err := rs.deidentify(map[string]any{"secret": "raw"}, nil)
	if err != nil {
		t.Fatalf("deidentify failed: %v", err)
	}
	if _, ok := result.(map[string]any)["secret"]; ok {
		t.Fatal("secret was not deleted")
	}
}

func TestCompileRulesValidation(t *testing.T) {
	tests := []struct {
		name string
		rule Rule
	}{
		{name: "empty path", rule: Rule{Path: nil, Action: Action{Type: ActionDelete}}},
		{name: "empty segment", rule: Rule{Path: []string{"a", ""}, Action: Action{Type: ActionDelete}}},
		{name: "missing action", rule: Rule{Path: []string{"a"}}},
		{name: "unknown action", rule: Rule{Path: []string{"a"}, Action: Action{Type: ActionType("scramble")}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := CompileRules([]Rule{test.rule})
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
		})
	}
}

func TestConfigErrorDoesNotContainEventValues(t *testing.T) {
	_, err := CompileRules([]Rule{
		{Path: []string{"secret"}, Action: Action{Type: ActionDelete}},
		{Path: []string{"secret"}, Action: Action{Type: ActionReplace, Replacement: "raw-value"}},
	})
	if err == nil {
		t.Fatal("expected configuration error")
	}
	if strings.Contains(err.Error(), "raw-value") {
		t.Fatalf("configuration error exposed an action value: %v", err)
	}
}
