package dataeng

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
)

// verifyBaseline streams the whole baseline through SHA256 in fixed-size
// chunks and compares the result with the expected fingerprint.
func verifyBaseline(ctx context.Context, b Baseline) error {
	if b.ReaderAt == nil {
		return fmt.Errorf("dataeng: baseline reader is nil")
	}
	if b.Length < 0 {
		return fmt.Errorf("%w: baseline length %d", ErrOverflow, b.Length)
	}

	h := sha256.New()
	buf := make([]byte, 4096)
	var pos int64
	for pos < b.Length {
		if err := ctx.Err(); err != nil {
			return err
		}
		want := b.Length - pos
		if want > int64(len(buf)) {
			want = int64(len(buf))
		}
		n, err := b.ReaderAt.ReadAt(buf[:want], pos)
		if n > 0 {
			h.Write(buf[:n])
			pos += int64(n)
		}
		if err != nil {
			if err == io.EOF && pos == b.Length {
				break
			}
			return fmt.Errorf("dataeng: baseline read failed: %w", err)
		}
		if n == 0 {
			return fmt.Errorf("dataeng: baseline read returned no progress at offset %d", pos)
		}
	}

	var got [32]byte
	copy(got[:], h.Sum(nil))
	if got != b.SHA256 {
		return ErrBaselineDigest
	}
	return nil
}

// validateSequence checks window identity, interval placement, declared
// lengths, instruction shapes and caller limits before anything executes.
func validateSequence(windows []Window, baselineLength int64, limits Limits) error {
	seen := make(map[string]struct{}, len(windows))
	var total int64
	for i := range windows {
		w := &windows[i]
		if _, dup := seen[w.ID]; dup {
			return fmt.Errorf("%w: id %q", ErrDuplicateWindow, w.ID)
		}
		seen[w.ID] = struct{}{}

		if w.TargetLength <= 0 {
			return fmt.Errorf("%w: window %q target length %d", ErrZeroLength, w.ID, w.TargetLength)
		}
		if limits.MaxWindowBytes > 0 && w.TargetLength > limits.MaxWindowBytes {
			return fmt.Errorf("%w: window %q T=%d > %d", ErrLimit, w.ID, w.TargetLength, limits.MaxWindowBytes)
		}

		if w.BaseOffset < 0 || w.Span <= 0 {
			return fmt.Errorf("%w: window %q interval offset=%d span=%d",
				ErrZeroLength, w.ID, w.BaseOffset, w.Span)
		}
		end, ok := add64(w.BaseOffset, w.Span)
		if !ok || end > baselineLength {
			return fmt.Errorf("%w: window %q interval [%d,+%d) outside baseline of %d",
				ErrOverflow, w.ID, w.BaseOffset, w.Span, baselineLength)
		}

		declared, err := validateInstructions(w)
		if err != nil {
			return err
		}
		if declared != w.TargetLength {
			return fmt.Errorf("%w: window %q instructions emit %d but T=%d",
				ErrLength, w.ID, declared, w.TargetLength)
		}

		total, ok = add64(total, w.TargetLength)
		if !ok {
			return fmt.Errorf("%w: total output length", ErrOverflow)
		}
		if limits.MaxTotalBytes > 0 && total > limits.MaxTotalBytes {
			return fmt.Errorf("%w: total output %d > %d", ErrLimit, total, limits.MaxTotalBytes)
		}
	}
	return nil
}

// validateInstructions walks the instruction list once, rejecting bad shapes,
// zero-length operations and overflowing output contributions. It returns the
// exact number of bytes the instructions will append.
func validateInstructions(w *Window) (int64, error) {
	var emitted int64
	for idx, ins := range w.Instructions {
		switch op := ins.(type) {
		case Add:
			n := int64(len(op.Bytes))
			if n <= 0 {
				return 0, fmt.Errorf("%w: window %q ADD[%d] empty", ErrZeroLength, w.ID, idx)
			}
			sum, ok := add64(emitted, n)
			if !ok {
				return 0, fmt.Errorf("%w: window %q ADD[%d]", ErrOverflow, w.ID, idx)
			}
			emitted = sum
		case Run:
			if op.Count <= 0 {
				return 0, fmt.Errorf("%w: window %q RUN[%d] count %d",
					ErrZeroLength, w.ID, idx, op.Count)
			}
			sum, ok := add64(emitted, op.Count)
			if !ok {
				return 0, fmt.Errorf("%w: window %q RUN[%d]", ErrOverflow, w.ID, idx)
			}
			emitted = sum
		case Copy:
			if op.Length <= 0 {
				return 0, fmt.Errorf("%w: window %q COPY[%d] length %d",
					ErrZeroLength, w.ID, idx, op.Length)
			}
			if op.Operand < 0 {
				return 0, fmt.Errorf("%w: window %q COPY[%d] operand %d",
					ErrAddress, w.ID, idx, op.Operand)
			}
			switch op.Mode {
			case CopySelf:
			case CopyHere:
			case CopyNear:
				if op.OperandSlot < 0 || op.OperandSlot > 3 {
					return 0, fmt.Errorf("%w: window %q COPY[%d] near slot %d",
						ErrAddress, w.ID, idx, op.OperandSlot)
				}
			case CopySame:
				if op.OperandSlot < 0 || op.OperandSlot > 2 {
					return 0, fmt.Errorf("%w: window %q COPY[%d] same row %d",
						ErrAddress, w.ID, idx, op.OperandSlot)
				}
				if op.Operand > 255 {
					return 0, fmt.Errorf("%w: window %q COPY[%d] same index %d",
						ErrAddress, w.ID, idx, op.Operand)
				}
			default:
				return 0, fmt.Errorf("%w: window %q COPY[%d] mode %d",
					ErrBadMode, w.ID, idx, op.Mode)
			}
			sum, ok := add64(emitted, op.Length)
			if !ok {
				return 0, fmt.Errorf("%w: window %q COPY[%d]", ErrOverflow, w.ID, idx)
			}
			emitted = sum
		case nil:
			return 0, fmt.Errorf("%w: window %q instruction[%d] is nil", ErrUnknownInstruction, w.ID, idx)
		default:
			return 0, fmt.Errorf("%w: window %q instruction[%d] type %T", ErrUnknownInstruction, w.ID, idx, ins)
		}
	}
	return emitted, nil
}
