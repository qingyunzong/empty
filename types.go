// Package dataeng applies vendor-supplied differential windows to rebuild a new
// resource from an immutable baseline.
//
// The package implements a deliberately naive, byte-by-byte patch interpreter.
// Each window owns an independent address cache (a four-slot near ring and a
// 3x256 same table) and can only read the declared baseline interval plus the
// bytes produced by that same window.
package dataeng

import (
	"context"
	"errors"
	"io"
)

// Sentinel errors returned by the package. Callers should use errors.Is.
var (
	// ErrBaselineDigest is returned when the baseline SHA256 differs from the
	// fingerprint supplied by the caller.
	ErrBaselineDigest = errors.New("dataeng: baseline fingerprint mismatch")

	// ErrDuplicateWindow is returned when the supplied sequence contains the
	// same window ID more than once.
	ErrDuplicateWindow = errors.New("dataeng: duplicate window id")

	// ErrConflict is returned when a window ID already exists in the store but
	// its baseline fingerprint or instruction sequence differs.
	ErrConflict = errors.New("dataeng: window id already committed with different input")

	// ErrLimit is returned when a declared or produced length exceeds a limit
	// configured by the caller.
	ErrLimit = errors.New("dataeng: declared length exceeds limit")

	// ErrOverflow is returned when an address or length cannot be represented
	// without an integer overflow.
	ErrOverflow = errors.New("dataeng: integer overflow")

	// ErrZeroLength is returned when an instruction or window declares a zero
	// (or negative) length where a positive value is required.
	ErrZeroLength = errors.New("dataeng: zero or negative length")

	// ErrAddress is returned when a COPY resolves to an address outside the
	// logical dictionary, to a negative value, or to a not-yet-produced byte.
	ErrAddress = errors.New("dataeng: invalid copy address")

	// ErrBadMode is returned for an unknown COPY address mode.
	ErrBadMode = errors.New("dataeng: unknown copy address mode")

	// ErrLength is returned when a window does not emit exactly its declared
	// target length T.
	ErrLength = errors.New("dataeng: produced target length differs from T")

	// ErrTargetDigest is returned when the produced target SHA256 differs from
	// the window's expected digest.
	ErrTargetDigest = errors.New("dataeng: target fingerprint mismatch")

	// ErrUnknownInstruction is returned when an instruction list contains a
	// value that is not Add, Run or Copy.
	ErrUnknownInstruction = errors.New("dataeng: unknown instruction")

	// ErrAmbiguousCommit is returned when a commit fails with an ambiguous
	// result and the follow-up lookup cannot settle the outcome either.
	ErrAmbiguousCommit = errors.New("dataeng: commit result unknown and recovery failed")
)

// CopyMode selects how a Copy instruction derives its dictionary address.
type CopyMode uint8

const (
	// CopySelf uses Operand directly as the dictionary address.
	CopySelf CopyMode = iota
	// CopyHere uses S + len(target) - Operand as the dictionary address.
	CopyHere
	// CopyNear uses near[OperandSlot] + Operand as the dictionary address.
	CopyNear
	// CopySame uses the same table row OperandSlot at index Operand as the
	// dictionary address.
	CopySame
)

// Instruction is the sealed interface implemented by Add, Run and Copy.
type Instruction interface {
	instruction()
}

// Add appends the literal Bytes to the window target.
type Add struct {
	Bytes []byte
}

// Run appends Byte Count times to the window target.
type Run struct {
	Byte  byte
	Count int64
}

// Copy copies Length bytes from the logical dictionary, starting at the
// address selected by Mode.
//
// For CopySelf and CopyNear, Operand is added to the slot value (for CopySelf
// the implicit slot value is zero). For CopyHere, Operand is subtracted from
// S + len(target). For CopySame, Operand is the 0..255 table index and
// OperandSlot selects the 0..2 table row. For CopyNear, OperandSlot selects
// the 0..3 near slot.
type Copy struct {
	Mode        CopyMode
	Length      int64
	Operand     int64
	OperandSlot int64
}

func (Add) instruction()  {}
func (Run) instruction()  {}
func (Copy) instruction() {}

// Baseline describes the immutable input shared by every window.
type Baseline struct {
	// ReaderAt serves the immutable baseline bytes. It must not change while
	// Apply runs.
	ReaderAt io.ReaderAt
	// Length is the exact baseline size in bytes.
	Length int64
	// SHA256 is the expected SHA256 digest of the whole baseline.
	SHA256 [32]byte
}

// Window is one differential unit. Only one window at a time can observe a
// dictionary; windows can never read another window's output.
type Window struct {
	// ID uniquely identifies the window within the sequence and the store.
	ID string
	// BaseOffset is the inclusive start of the baseline interval.
	BaseOffset int64
	// Span S is the length of the baseline interval starting at BaseOffset.
	Span int64
	// TargetLength T is the exact number of bytes the window must emit.
	TargetLength int64
	// Instructions rebuild the target from an empty byte slice.
	Instructions []Instruction
	// TargetSHA256 is the expected SHA256 digest of the emitted target.
	TargetSHA256 [32]byte
}

// Limits bounds the work the caller is willing to accept. A zero value means
// unbounded, except that any value that would overflow int64 is still rejected.
type Limits struct {
	// MaxWindowBytes bounds every window's declared target length T.
	MaxWindowBytes int64
	// MaxTotalBytes bounds the sum of every window's T.
	MaxTotalBytes int64
}

// Result reports what Apply produced.
type Result struct {
	// Resource is the concatenation of the committed window targets in input
	// order. Already-committed windows that are reapplied are included.
	Resource []byte
	// Committed lists the IDs newly committed by this call, in input order.
	Committed []string
	// Skipped lists the IDs that were already committed with identical content,
	// in input order.
	Skipped []string
}

// Record is the transactional state stored per window ID by a WindowStore.
type Record struct {
	// BaselineSHA256 identifies the baseline fingerprint used to apply the
	// window.
	BaselineSHA256 [32]byte
	// InstructionHash is the canonical digest of the full window declaration,
	// including the interval, T, instructions and expected target digest.
	InstructionHash [32]byte
	// TargetSHA256 is the digest of the committed target bytes.
	TargetSHA256 [32]byte
	// Target is the committed target itself.
	Target []byte
}

// WindowStore is the transactional host interface. Implementations must be
// safe for concurrent use.
type WindowStore interface {
	// Lookup returns the stored record and true for a known ID. An unknown ID
	// returns false with a nil error.
	Lookup(ctx context.Context, id string) (Record, bool, error)
	// Commit stores record under id. Committing an ID that already exists must
	// fail instead of overwriting it.
	Commit(ctx context.Context, id string, record Record) error
}

// Applier applies an ordered sequence of windows against one baseline.
type Applier struct {
	Baseline Baseline
	Store    WindowStore
	Limits   Limits
}

// add64 returns a+b and false on signed overflow.
func add64(a, b int64) (int64, bool) {
	sum := a + b
	if (sum < a) != (b < 0) {
		return 0, false
	}
	return sum, true
}

// sub64 returns a-b and false on signed overflow.
func sub64(a, b int64) (int64, bool) {
	diff := a - b
	if (diff > a) != (b < 0) {
		return 0, false
	}
	return diff, true
}
