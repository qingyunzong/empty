package fieldsync

import (
	"fmt"
	"strings"
)

// VerificationError reports that a write was accepted by the store but the
// read-back state does not match the desired batch. It preserves the original
// write Receipt and the concrete Diffs observed on the final read-back.
type VerificationError struct {
	Key     string
	Receipt Receipt
	Diffs   []Diff
}

func (e *VerificationError) Error() string {
	parts := make([]string, len(e.Diffs))
	for i, d := range e.Diffs {
		parts[i] = d.String()
	}
	return fmt.Sprintf("fieldsync: read-back verification failed for key %q (receipt version=%d token=%q): %s",
		e.Key, e.Receipt.Version, e.Receipt.Token, strings.Join(parts, "; "))
}
