package dataeng

import (
	"context"
	"fmt"
)

// Apply verifies the baseline fingerprint and the whole window sequence, then
// applies each window in input order. Windows already present in Store with
// identical content are skipped; identical IDs with different declarations or
// baseline fingerprints are rejected.
//
// Apply is all-or-nothing with respect to failed windows: if any window
// cannot be produced or committed, the error is returned and windows later in
// the sequence are not applied. The returned Result is still populated for the
// windows that were committed before the failure.
func (a *Applier) Apply(ctx context.Context, windows []Window) (Result, error) {
	if a == nil {
		return Result{}, fmt.Errorf("dataeng: nil applier")
	}
	if a.Store == nil {
		return Result{}, fmt.Errorf("dataeng: window store is required")
	}
	if err := a.Limits.check(); err != nil {
		return Result{}, err
	}

	// 1. Stream the entire baseline fingerprint before trusting any window.
	if err := verifyBaseline(ctx, a.Baseline); err != nil {
		return Result{}, err
	}

	// 2. Validate the complete window sequence up front: unique IDs, interval
	// placement, instruction shapes, exact T and caller limits.
	if err := validateSequence(windows, a.Baseline.Length, a.Limits); err != nil {
		return Result{}, err
	}

	result := Result{
		Committed: make([]string, 0, len(windows)),
		Skipped:   make([]string, 0, len(windows)),
	}
	totalSize, ok := sumTargetLengths(windows)
	if !ok {
		return Result{}, fmt.Errorf("%w: total resource size", ErrOverflow)
	}
	if a.Limits.MaxTotalBytes > 0 && totalSize > a.Limits.MaxTotalBytes {
		return Result{}, fmt.Errorf("%w: total T %d > %d", ErrLimit, totalSize, a.Limits.MaxTotalBytes)
	}
	resource := make([]byte, 0, int(totalSize))

	var runningTotal int64
	for i := range windows {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		w := &windows[i]
		instructionHash := hashWindow(*w)

		// 3. Never reapply a known ID. First reconcile with the store so an
		// ambiguous prior commit is handled without rebuilding the window.
		stored, found, err := a.Store.Lookup(ctx, w.ID)
		if err != nil {
			return result, fmt.Errorf("dataeng: lookup window %q: %w", w.ID, err)
		}
		expected := Record{
			BaselineSHA256:  a.Baseline.SHA256,
			InstructionHash: instructionHash,
			TargetSHA256:    w.TargetSHA256,
		}
		if found {
			if stored.BaselineSHA256 != expected.BaselineSHA256 ||
				stored.InstructionHash != expected.InstructionHash ||
				stored.TargetSHA256 != expected.TargetSHA256 {
				return result, fmt.Errorf("%w: window %q", ErrConflict, w.ID)
			}
			resource = append(resource, stored.Target...)
			result.Skipped = append(result.Skipped, w.ID)
			runningTotal, ok = add64(runningTotal, int64(len(stored.Target)))
			if !ok {
				return result, fmt.Errorf("%w: resource size", ErrOverflow)
			}
			continue
		}

		// 4. Build the window with a fresh interpreter and verify its exact
		// length and digest before contacting the store.
		target, targetDigest, err := runWindow(ctx, a.Baseline, w, a.Limits, runningTotal)
		if err != nil {
			return result, err
		}

		record := Record{
			BaselineSHA256:  a.Baseline.SHA256,
			InstructionHash: instructionHash,
			TargetSHA256:    targetDigest,
			Target:          target,
		}

		// 5. Transactional commit with unknown-outcome recovery.
		committed, err := commitOrRecover(ctx, a.Store, w.ID, record)
		if err != nil {
			return result, err
		}
		resource = append(resource, target...)
		runningTotal, ok = add64(runningTotal, int64(len(target)))
		if !ok {
			return result, fmt.Errorf("%w: resource size", ErrOverflow)
		}
		if committed {
			result.Committed = append(result.Committed, w.ID)
		} else {
			result.Skipped = append(result.Skipped, w.ID)
		}
	}

	result.Resource = resource
	return result, nil
}

func (l Limits) check() error {
	if l.MaxWindowBytes < 0 || l.MaxTotalBytes < 0 {
		return fmt.Errorf("%w: negative limit", ErrLimit)
	}
	return nil
}

func sumTargetLengths(windows []Window) (int64, bool) {
	var total int64
	for i := range windows {
		next, ok := add64(total, windows[i].TargetLength)
		if !ok {
			return 0, false
		}
		total = next
	}
	return total, true
}
