package synclib

import (
	"fmt"
	"strings"
)

// DiffKind classifies a single read-back discrepancy.
type DiffKind int

const (
	DiffFieldMismatch DiffKind = iota
	DiffFieldMissing
	DiffFieldExtra
	DiffAttachmentMissing
	DiffAttachmentExtra
)

func (k DiffKind) String() string {
	switch k {
	case DiffFieldMismatch:
		return "field-mismatch"
	case DiffFieldMissing:
		return "field-missing"
	case DiffFieldExtra:
		return "field-extra"
	case DiffAttachmentMissing:
		return "attachment-missing"
	case DiffAttachmentExtra:
		return "attachment-extra"
	}
	return "unknown"
}

// Diff describes one concrete discrepancy between wanted and read-back state.
// Field holds the field name, or the attachment hash for attachment diffs.
type Diff struct {
	Kind  DiffKind
	Field string
	Want  string
	Got   string
}

// MismatchError reports a failed read-back verification. It retains the
// original write Receipt and every specific Diff found.
type MismatchError struct {
	Receipt Receipt
	Diffs   []Diff
}

func (e *MismatchError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "synclib: read-back mismatch for %q (write version %d):",
		e.Receipt.ID, e.Receipt.Version)
	for _, d := range e.Diffs {
		fmt.Fprintf(&b, "\n  %s %s: want %q, got %q", d.Kind, d.Field, d.Want, d.Got)
	}
	return b.String()
}
