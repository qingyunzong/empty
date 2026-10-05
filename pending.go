package planexec

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// PendingTail is the persisted evidence of an incomplete rollback: the
// steps that remain applied (or in an unknown state) and why recovery
// stopped.
type PendingTail struct {
	SavedAt time.Time `json:"saved_at"`
	// Cause is "rollback_error" or "external_modification".
	Cause   string   `json:"cause"`
	Detail  string   `json:"detail"`
	Pending []string `json:"pending"`
}

// SavePendingTailFile persists the unrecovered tail of r as JSON.
// It returns (nil, nil) when there is nothing pending.
func SavePendingTailFile(path string, r *Result) (*PendingTail, error) {
	if len(r.Pending) == 0 {
		return nil, nil
	}
	tail := &PendingTail{SavedAt: time.Now().UTC(), Pending: r.Pending}
	switch {
	case r.RollbackErr != nil:
		tail.Cause = "rollback_error"
		tail.Detail = r.RollbackErr.Error()
	case len(r.Conflicts) > 0:
		tail.Cause = "external_modification"
		tail.Detail = r.Conflicts[len(r.Conflicts)-1].Detail
	default:
		tail.Cause = "unknown"
	}
	data, err := json.MarshalIndent(tail, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, fmt.Errorf("save pending tail: %w", err)
	}
	return tail, nil
}

// LoadPendingTailFile reads a previously saved PendingTail.
func LoadPendingTailFile(path string) (*PendingTail, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("load pending tail: %w", err)
	}
	var tail PendingTail
	if err := json.Unmarshal(data, &tail); err != nil {
		return nil, fmt.Errorf("load pending tail: %w", err)
	}
	return &tail, nil
}
