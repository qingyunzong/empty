package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// ErrNotRelocatable is the sentinel wrapped by RelocationError.
var ErrNotRelocatable = errors.New("dataeng: symbol token not relocatable")

// RelocationError reports the first token in a relocation sequence that
// cannot be represented by the target snapshot. Index is zero-based.
type RelocationError struct {
	Index  int
	Token  Token
	Reason string
}

func (e *RelocationError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("dataeng: token %d (%s) is not relocatable",
			e.Index, e.Token)
	}
	return fmt.Sprintf("dataeng: token %d (%s) is not relocatable: %s",
		e.Index, e.Token, e.Reason)
}

func (e *RelocationError) Unwrap() error { return ErrNotRelocatable }

// Relocate converts a token sequence from any old snapshot into SIDs of
// target. It is all-or-nothing.
//
// Known tokens use the smallest existing target SID. Missing texts are
// appended to target local slots in first-occurrence order, with each exact
// text appended once. LocalUnknown is encoded as SID 0. SharedUnknown is
// accepted only when target currently contains an import slot resolving to
// that same (name, ordinal) unknown identity.
//
// If any token is not representable, result is nil and error is a
// *RelocationError carrying the first failing index; target is unchanged.
// On success result is a new target snapshot (or target itself when no local
// slots were appended) and every result SID resolves to a token Equivalent
// to its source token.
func Relocate(tokens []Token, target *Context) (*Context, []uint64, error) {
	result, sids, _, err := RelocateWithIndex(tokens, target)
	return result, sids, err
}

// RelocateWithIndex is Relocate with the first failing token index returned
// directly. On success failIndex is -1. On failure result and sids are nil and
// target is unchanged.
func RelocateWithIndex(tokens []Token, target *Context) (*Context, []uint64, int, error) {
	if target == nil {
		return nil, nil, 0, &RelocationError{
			Index:  0,
			Reason: "nil target context",
		}
	}

	sids := make([]uint64, len(tokens))
	appendedTexts := make([]string, 0)
	appendedSIDs := make(map[string]uint64)

	for index, token := range tokens {
		switch token.Kind {
		case LocalUnknownKind:
			sids[index] = 0

		case KnownKind:
			if sid, ok := target.lookupKnown(token.Text); ok {
				sids[index] = sid
				continue
			}
			if sid, ok := appendedSIDs[token.Text]; ok {
				sids[index] = sid
				continue
			}
			if uint64(len(appendedTexts)) >= math.MaxUint64-target.maxSID {
				return nil, nil, index, &RelocationError{
					Index:  index,
					Token:  token,
					Reason: "local append would overflow the SID space",
				}
			}
			appendedTexts = append(appendedTexts, token.Text)
			sid := target.maxSID + uint64(len(appendedTexts))
			appendedSIDs[token.Text] = sid
			sids[index] = sid

		case SharedUnknownKind:
			sid, ok := target.Lookup(token)
			if !ok {
				return nil, nil, index, &RelocationError{
					Index:  index,
					Token:  token,
					Reason: "target has no import slot with this unknown identity",
				}
			}
			sids[index] = sid

		default:
			return nil, nil, index, &RelocationError{
				Index:  index,
				Token:  token,
				Reason: "invalid token kind",
			}
		}
	}

	var result *Context
	var err error
	if len(appendedTexts) != 0 {
		result, err = target.AppendLocal(appendedTexts...)
		if err != nil {
			return nil, nil, 0, &RelocationError{
				Index:  0,
				Reason: err.Error(),
			}
		}
	} else {
		result = target
	}

	// The delivery contract requires every SID to denote the source identity
	// in the new snapshot. This should be true by construction; checking it
	// keeps the all-or-nothing boundary explicit.
	for index, token := range tokens {
		resolved, err := result.Resolve(sids[index])
		if err != nil || !Equivalent(token, resolved) {
			return nil, nil, index, &RelocationError{
				Index:  index,
				Token:  token,
				Reason: "result SID does not resolve to the source identity",
			}
		}
	}

	return result, sids, -1, nil
}

// Relocate converts tokens into this target snapshot. See Relocate.
func (c *Context) Relocate(tokens []Token) (*Context, []uint64, error) {
	return Relocate(tokens, c)
}

// RelocateWithIndex converts tokens into this target snapshot and returns the
// first failing index. See RelocateWithIndex.
func (c *Context) RelocateWithIndex(tokens []Token) (*Context, []uint64, int, error) {
	return RelocateWithIndex(tokens, c)
}
