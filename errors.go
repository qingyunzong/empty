package formal

import "errors"

var (
	// ErrInvalidConfig reports a configuration that cannot produce a
	// deterministic protocol (for example a non-positive timeout).
	ErrInvalidConfig = errors.New("formal: invalid configuration")

	// ErrInvalidMember reports an empty member identifier.
	ErrInvalidMember = errors.New("formal: invalid member identifier")

	// ErrUnknownMember reports a reconnect or failure report for a member
	// that has never joined.
	ErrUnknownMember = errors.New("formal: unknown member")

	// ErrNoGeneration reports a confirmation when no generation has ever
	// been opened.
	ErrNoGeneration = errors.New("formal: no generation")

	// ErrStaleGeneration reports a confirmation aimed at a generation that
	// has already been superseded or closed.
	ErrStaleGeneration = errors.New("formal: stale generation")

	// ErrUnknownGeneration reports a confirmation for a generation that has
	// not been opened yet.
	ErrUnknownGeneration = errors.New("formal: unknown generation")

	// ErrNotMember reports a confirmation from a member that does not
	// belong to the targeted generation.
	ErrNotMember = errors.New("formal: member is not in generation")

	// ErrGenerationClosed reports a confirmation for a closed generation
	// when the member did not previously confirm that generation.
	ErrGenerationClosed = errors.New("formal: generation is closed")

	// ErrInvalidGeneration reports a generation snapshot whose internal
	// invariants are broken. It is primarily useful to model checkers and
	// tests.
	ErrInvalidGeneration = errors.New("formal: invalid generation")
)
