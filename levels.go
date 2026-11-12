package dataeng

import (
	"errors"
	"fmt"
)

// Token is one columnar repetition/definition level record for the
// nullable type list<list<int64?>>.
//
// Definition level D:
//
//	0: the outer list itself is null
//	1: the outer list is empty
//	2: an outer element (the inner list) is null
//	3: the inner list is empty
//	4: an inner element (the int64 leaf) is null
//	5: the leaf carries a value
//
// Repetition level R:
//
//	0: the token starts a new row
//	1: the token starts the next outer element of the current row
//	2: the token continues the current inner list
type Token struct {
	R     int
	D     int
	Value *int64
}

// Row is the host-facing representation of list<list<int64?>> where
// every layer is nullable.
//
// A nil Outer means the outer list is null, while a non-nil but empty
// Outer means the outer list is empty. A nil inner slice means that
// outer element is null, while an empty non-nil inner slice means the
// inner list is empty. A nil leaf means the int64 value is null. Null
// and empty are always kept distinct.
type Row struct {
	Outer *[][]*int64
}

const (
	maxRepetition = 2
	maxDefinition = 5
)

// LevelValidator is the independent per-token state machine. It checks
// the level ranges, the first-token rule, the r=1/r=2 adjacency rules,
// the rule that only d=5 carries a value, and the final row count. It
// keeps state across batches, so a stream may be fed through Next one
// batch at a time.
type LevelValidator struct {
	started bool
	prevD   int
	rows    int
}

type validatorState struct {
	started bool
	prevD   int
	rows    int
}

// NewLevelValidator returns a validator ready for the first token.
func NewLevelValidator() *LevelValidator {
	return &LevelValidator{}
}

// Reset restores the validator to its initial state.
func (v *LevelValidator) Reset() {
	*v = LevelValidator{}
}

// Rows reports how many r=0 tokens (started rows) have been accepted.
func (v *LevelValidator) Rows() int {
	return v.rows
}

func (v *LevelValidator) snapshot() validatorState {
	return validatorState{started: v.started, prevD: v.prevD, rows: v.rows}
}

func (v *LevelValidator) restore(state validatorState) {
	v.started = state.started
	v.prevD = state.prevD
	v.rows = state.rows
}

// Next validates a single token against the stream state.
func (v *LevelValidator) Next(tok Token) error {
	if tok.R < 0 || tok.R > maxRepetition {
		return fmt.Errorf("repetition level %d out of range [0,%d]", tok.R, maxRepetition)
	}
	if tok.D < 0 || tok.D > maxDefinition {
		return fmt.Errorf("definition level %d out of range [0,%d]", tok.D, maxDefinition)
	}

	if !v.started {
		if tok.R != 0 {
			return fmt.Errorf("first token must have repetition level 0, got r=%d", tok.R)
		}
	} else {
		switch tok.R {
		case 1:
			if v.prevD < 2 || tok.D < 2 {
				return fmt.Errorf("r=1 requires adjacent definition levels >= 2, got d=%d -> d=%d", v.prevD, tok.D)
			}
		case 2:
			if v.prevD < 4 || tok.D < 4 {
				return fmt.Errorf("r=2 requires adjacent definition levels >= 4, got d=%d -> d=%d", v.prevD, tok.D)
			}
		}
	}

	if (tok.D == maxDefinition) != (tok.Value != nil) {
		if tok.D == maxDefinition {
			return errors.New("d=5 token must carry a non-nil value")
		}
		return fmt.Errorf("d=%d token must not carry a value", tok.D)
	}

	if tok.R == 0 {
		v.rows++
	}
	v.started = true
	v.prevD = tok.D
	return nil
}

// End confirms the stream is complete and that exactly wantRows rows
// were present. An empty stream is valid only for wantRows == 0.
func (v *LevelValidator) End(wantRows int) error {
	if wantRows < 0 {
		return fmt.Errorf("wantRows must be non-negative, got %d", wantRows)
	}
	if v.rows != wantRows {
		return fmt.Errorf("row count mismatch: stream started %d rows, want %d", v.rows, wantRows)
	}
	return nil
}

// ValidateTokenStream runs the per-token state machine over a whole
// stream and checks the expected row count.
func ValidateTokenStream(tokens []Token, wantRows int) error {
	validator := NewLevelValidator()
	for _, tok := range tokens {
		if err := validator.Next(tok); err != nil {
			return err
		}
	}
	return validator.End(wantRows)
}

// EncodeRows converts host rows into a columnar token stream. Null and
// empty layers produce distinct definition levels, and every non-nil
// leaf becomes a d=5 token carrying a copy of its value.
func EncodeRows(rows []Row) []Token {
	out := make([]Token, 0)
	for _, row := range rows {
		if row.Outer == nil {
			out = append(out, Token{R: 0, D: 0})
			continue
		}

		outer := *row.Outer
		if len(outer) == 0 {
			out = append(out, Token{R: 0, D: 1})
			continue
		}

		for outerIndex, inner := range outer {
			elementR := 0
			if outerIndex > 0 {
				elementR = 1
			}

			if inner == nil {
				out = append(out, Token{R: elementR, D: 2})
				continue
			}
			if len(inner) == 0 {
				out = append(out, Token{R: elementR, D: 3})
				continue
			}

			for innerIndex, leaf := range inner {
				r := elementR
				if innerIndex > 0 {
					r = 2
				}
				if leaf == nil {
					out = append(out, Token{R: r, D: 4})
				} else {
					out = append(out, Token{R: r, D: maxDefinition, Value: copyValue(leaf)})
				}
			}
		}
	}
	return out
}

func copyValue(src *int64) *int64 {
	if src == nil {
		return nil
	}
	value := *src
	return &value
}
