// Package captoken implements a capability-token library.
//
// A token carries a resource prefix, a set of actions, and a half-open
// validity window [NotBefore, NotAfter). Child tokens are created by
// attenuation: they may only narrow the resource prefix, shrink the action
// set, and shorten (never extend) the validity window. Revoking any
// ancestor invalidates all of its descendants.
//
// Signature verification is delegated to an injectable Verifier, and
// successful verification returns the evidence collected along the chain.
package captoken

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Sentinel errors returned by Store operations.
var (
	ErrUnknownToken     = errors.New("captoken: unknown token")
	ErrDuplicateToken   = errors.New("captoken: duplicate token id")
	ErrRootHasParent    = errors.New("captoken: root token must not have a parent")
	ErrNotChildOfParent = errors.New("captoken: token parent mismatch")
	ErrBadSignature     = errors.New("captoken: invalid signature")
	ErrResourceWidened  = errors.New("captoken: child resource is not under parent prefix")
	ErrActionsWidened   = errors.New("captoken: child actions are not a subset of parent actions")
	ErrValidityExtended = errors.New("captoken: child validity extends beyond parent validity")
	ErrRevoked          = errors.New("captoken: token or an ancestor has been revoked")
	ErrNotYetValid      = errors.New("captoken: token is not yet valid")
	ErrExpired          = errors.New("captoken: token validity has ended")
	ErrEmptyWindow      = errors.New("captoken: validity window is empty")
)

// Token is a capability token. The validity window is half-open:
// the token is valid at time t when NotBefore <= t < NotAfter.
type Token struct {
	ID        string
	Parent    string // empty for root tokens
	Resource  string // resource prefix this token covers
	Actions   []string
	NotBefore time.Time
	NotAfter  time.Time
	Signature []byte
}

// Contains reports whether t is within the half-open validity window.
func (t *Token) Contains(at time.Time) bool {
	return !at.Before(t.NotBefore) && at.Before(t.NotAfter)
}

// payload is the canonical byte representation covered by the signature.
func (t *Token) payload() []byte {
	actions := make([]string, len(t.Actions))
	copy(actions, t.Actions)
	sort.Strings(actions)
	parts := []string{
		t.ID,
		t.Parent,
		t.Resource,
		strings.Join(actions, "\x1e"),
		strconv.FormatInt(t.NotBefore.UnixNano(), 10),
		strconv.FormatInt(t.NotAfter.UnixNano(), 10),
	}
	return []byte(strings.Join(parts, "\x1f"))
}

// Verifier checks a token signature. Implementations are injected into a
// Store so callers can plug in any signature scheme.
type Verifier interface {
	Verify(payload, signature []byte) error
}

// VerifierFunc adapts a plain function to the Verifier interface.
type VerifierFunc func(payload, signature []byte) error

// Verify implements Verifier.
func (f VerifierFunc) Verify(payload, signature []byte) error {
	return f(payload, signature)
}

// validateWindow checks the token's own validity window is well formed.
func validateWindow(t *Token) error {
	if !t.NotBefore.Before(t.NotAfter) {
		return fmt.Errorf("%w: [%s, %s)", ErrEmptyWindow, t.NotBefore, t.NotAfter)
	}
	return nil
}

// checkAttenuation verifies that child only narrows parent and never
// extends it.
func checkAttenuation(parent, child *Token) error {
	if !strings.HasPrefix(child.Resource, parent.Resource) {
		return fmt.Errorf("%w: %q is not under %q", ErrResourceWidened, child.Resource, parent.Resource)
	}
	parentActions := make(map[string]bool, len(parent.Actions))
	for _, a := range parent.Actions {
		parentActions[a] = true
	}
	for _, a := range child.Actions {
		if !parentActions[a] {
			return fmt.Errorf("%w: action %q not granted by parent", ErrActionsWidened, a)
		}
	}
	if child.NotBefore.Before(parent.NotBefore) || child.NotAfter.After(parent.NotAfter) {
		return fmt.Errorf("%w: child window [%s, %s) exceeds parent [%s, %s)",
			ErrValidityExtended, child.NotBefore, child.NotAfter, parent.NotBefore, parent.NotAfter)
	}
	return nil
}
