package q204

import "fmt"

// ActionType identifies the operation applied to a matched value.
type ActionType string

const (
	// ActionDelete removes the matched value. When the matched value is an
	// array, its elements are treated as the matches; the array becomes empty
	// (or stays empty when it already was).
	ActionDelete ActionType = "delete"
	// ActionReplace replaces the matched value with Replacement. Array
	// elements are replaced individually.
	ActionReplace ActionType = "replace"
	// ActionHMAC replaces a string with the lowercase hex encoding of
	// HMAC-SHA256(key, []byte(value)). Non-string values are rejected.
	ActionHMAC ActionType = "hmac"
)

// Action describes what happens to a value selected by a rule.
//
// Replacement is only meaningful for ActionReplace. It is ignored for the
// other action types, which keeps configuration comparison unambiguous.
type Action struct {
	Type        ActionType `json:"type"`
	Replacement string     `json:"replacement,omitempty"`
}

func (a Action) validate() error {
	switch a.Type {
	case ActionDelete, ActionHMAC, ActionReplace:
		return nil
	case "":
		return fmt.Errorf("%w: missing action type", ErrInvalidConfig)
	default:
		return fmt.Errorf("%w: unknown action type %q", ErrInvalidConfig, a.Type)
	}
}

func (a Action) canonical() Action {
	if a.Type != ActionReplace {
		a.Replacement = ""
	}
	return a
}

func (a Action) equal(other Action) bool {
	return a.canonical() == other.canonical()
}
