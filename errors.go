package dataeng

import "fmt"

// ConflictReason classifies why a whole record was rejected.
type ConflictReason string

const (
	// ReasonInvalidInput: malformed segment, ordinal, limits, or leaf value.
	ReasonInvalidInput ConflictReason = "invalid_input"
	// ReasonTypeConflict: a position is used both as a container and as a
	// value, or arrays and objects are mixed at the same position.
	ReasonTypeConflict ConflictReason = "type_conflict"
	// ReasonValueMismatch: the same path was submitted with structurally
	// different values.
	ReasonValueMismatch ConflictReason = "value_mismatch"
	// ReasonIndexTooLarge: an index exceeds Limits.MaxArrayIndex or cannot be
	// materialized safely.
	ReasonIndexTooLarge ConflictReason = "index_too_large"
	// ReasonCellBudget: expanding the arrays would exceed Limits.MaxCells.
	ReasonCellBudget ConflictReason = "cell_budget_exceeded"
)

// ConflictError describes a rejected record. Path is a copied prefix of the
// offending field path and Ordinal is its source sequence number.
type ConflictError struct {
	Reason  ConflictReason
	Path    []Segment
	Ordinal int
	Detail  string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("dataeng: %s at %s (field ordinal %d): %s",
		e.Reason, formatPath(e.Path), e.Ordinal, e.Detail)
}

func conflict(reason ConflictReason, path []Segment, ordinal int, detail string) *ConflictError {
	err := &ConflictError{Reason: reason, Ordinal: ordinal, Detail: detail}
	if len(path) > 0 {
		err.Path = append([]Segment(nil), path...)
	}
	return err
}

func formatPath(segs []Segment) string {
	if len(segs) == 0 {
		return "<root>"
	}
	out := ""
	for _, seg := range segs {
		switch seg.Kind {
		case Name:
			out += "." + seg.Name
		case Index:
			out += fmt.Sprintf("[%d]", seg.Index)
		default:
			out += "<?>"
		}
	}
	return out
}

func kindName(k Kind) string {
	switch k {
	case Object:
		return "object"
	case Array:
		return "array"
	case Leaf:
		return "value"
	case Missing:
		return "missing"
	default:
		return "unknown"
	}
}
