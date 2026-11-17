package formal

import (
	"context"
	"fmt"
	"sort"
)

// Report is the result of comparing an index with a table snapshot.
type Report struct {
	TableKeys  int
	IndexKeys  int
	Missing    []Key // committed table keys absent from the index
	Ghosts     []Key // index keys absent from the committed table
	Mismatched []Key // keys present in both with different values
}

// OK reports whether the index exactly matches the table snapshot.
func (r Report) OK() bool {
	return len(r.Missing) == 0 && len(r.Ghosts) == 0 && len(r.Mismatched) == 0
}

// String renders a compact verification summary.
func (r Report) String() string {
	return fmt.Sprintf("table_keys=%d index_keys=%d missing=%d ghosts=%d mismatched=%d",
		r.TableKeys, r.IndexKeys, len(r.Missing), len(r.Ghosts), len(r.Mismatched))
}

// VerificationError is returned by SnapshotAuditor when the comparison finds
// any missing, ghost, or mismatched key.
type VerificationError struct {
	At     Seq
	Report Report
}

func (e *VerificationError) Error() string {
	return fmt.Sprintf("formal: index does not cover table at seq %d: %s", e.At, e.Report)
}

// Unwrap allows errors.Is(err, ErrVerification).
func (e *VerificationError) Unwrap() error { return ErrVerification }

// Compare scans snap and compares it with the index. It reports missing keys
// (committed in the table, absent from the index), ghost keys (present in the
// index, absent or deleted in the table), and value mismatches.
func Compare(ctx context.Context, index Index, snap Snapshot) (Report, error) {
	if index == nil {
		return Report{}, fmt.Errorf("formal: nil index")
	}
	if snap == nil {
		return Report{}, fmt.Errorf("formal: nil snapshot")
	}

	table := make(map[Key]Value)
	if err := snap.Scan(ctx, func(k Key, v Value) error {
		if err := contextErr(ctx); err != nil {
			return err
		}
		if _, exists := table[k]; exists {
			return fmt.Errorf("%w: %q", ErrSnapshotDuplicate, k)
		}
		table[k] = v
		return nil
	}); err != nil {
		return Report{}, err
	}

	entries := index.Entries()
	report := Report{TableKeys: len(table), IndexKeys: len(entries)}
	for k, want := range table {
		got, ok := entries[k]
		switch {
		case !ok:
			report.Missing = append(report.Missing, k)
		case got != want:
			report.Mismatched = append(report.Mismatched, k)
		}
	}
	for k := range entries {
		if _, ok := table[k]; !ok {
			report.Ghosts = append(report.Ghosts, k)
		}
	}
	sortKeys(report.Missing)
	sortKeys(report.Ghosts)
	sortKeys(report.Mismatched)
	return report, nil
}

// Verify is an alias for Compare.
func Verify(ctx context.Context, index Index, snap Snapshot) (Report, error) {
	return Compare(ctx, index, snap)
}

// SnapshotAuditor compares the index with a historical snapshot at the exact
// certificate barrier. It is the strictest available pre-visibility proof.
type SnapshotAuditor struct {
	Source HistoricalSnapshotSource
}

var _ Auditor = SnapshotAuditor{}

// Audit implements Auditor.
func (a SnapshotAuditor) Audit(ctx context.Context, at Seq, index Index) error {
	if a.Source == nil {
		return fmt.Errorf("formal: SnapshotAuditor has nil source")
	}
	snap, err := a.Source.OpenSnapshotAt(ctx, at)
	if err != nil {
		return err
	}
	report, err := Compare(ctx, index, snap)
	if err != nil {
		return err
	}
	if !report.OK() {
		return &VerificationError{At: at, Report: report}
	}
	return nil
}

func sortKeys(keys []Key) {
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
}
