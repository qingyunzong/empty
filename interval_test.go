package dataeng_test

import (
	"errors"
	"testing"

	"example.org/dataeng13/q0419"
)

func k(values ...string) [][]byte {
	keys := make([][]byte, len(values))
	for i, value := range values {
		keys[i] = []byte(value)
	}
	return keys
}

func TestIntervalClosedAndByteOrdered(t *testing.T) {
	interval := dataeng.Interval{Start: []byte("A"), End: []byte("z")}

	for _, key := range []string{"A", "M", "z"} {
		if !interval.Contains([]byte(key)) {
			t.Fatalf("interval %s should contain %q", interval, key)
		}
	}
	for _, key := range []string{"", "0", "{"} {
		if interval.Contains([]byte(key)) {
			t.Fatalf("interval %s should not contain %q", interval, key)
		}
	}

	// Byte order compares uppercase before lowercase.
	if !interval.Contains([]byte("a")) {
		t.Fatal("lowercase a sorts before lowercase z")
	}
}

func TestValidateIntervalsRejectsInvalidAndDuplicateStarts(t *testing.T) {
	invalid := []dataeng.Interval{{Start: []byte("b"), End: []byte("a")}}
	if err := dataeng.ValidateIntervals(invalid); !errors.Is(err, dataeng.ErrInvalidInterval) {
		t.Fatalf("expected ErrInvalidInterval, got %v", err)
	}
	if _, err := dataeng.NewValidator(invalid); !errors.Is(err, dataeng.ErrInvalidInterval) {
		t.Fatalf("expected constructor ErrInvalidInterval, got %v", err)
	}

	duplicate := []dataeng.Interval{
		{Start: []byte("a"), End: []byte("c")},
		{Start: []byte("a"), End: []byte("d")},
	}
	if err := dataeng.ValidateIntervals(duplicate); !errors.Is(err, dataeng.ErrDuplicateStart) {
		t.Fatalf("expected ErrDuplicateStart, got %v", err)
	}
	if _, err := dataeng.NewValidator(duplicate); !errors.Is(err, dataeng.ErrDuplicateStart) {
		t.Fatalf("expected constructor ErrDuplicateStart, got %v", err)
	}

	// nil and empty keys have the same byte representation and therefore
	// share a start.
	duplicateEmpty := []dataeng.Interval{
		{Start: nil, End: []byte("a")},
		{Start: []byte{}, End: []byte("b")},
	}
	if err := dataeng.ValidateIntervals(duplicateEmpty); !errors.Is(err, dataeng.ErrDuplicateStart) {
		t.Fatalf("expected ErrDuplicateStart for nil/empty starts, got %v", err)
	}
}

func TestOverlappingStartsAreAllowedButEqualStartsAreNot(t *testing.T) {
	intervals := []dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
		{Start: []byte("d"), End: []byte("z")},
	}
	if err := dataeng.ValidateIntervals(intervals); err != nil {
		t.Fatalf("overlap with distinct starts should be valid: %v", err)
	}
	if !intervals[0].Overlaps(intervals[1]) {
		t.Fatal("intervals should overlap")
	}

	disjoint := []dataeng.Interval{
		{Start: []byte("a"), End: []byte("c")},
		{Start: []byte("d"), End: []byte("z")},
	}
	if disjoint[0].Overlaps(disjoint[1]) {
		t.Fatal("intervals should not overlap")
	}
}

func TestValidatorRejectsOutOfRangeBatchAtomically(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
	})
	if err != nil {
		t.Fatal(err)
	}

	// A bad key anywhere in the batch rejects all keys; the interval remains
	// incomplete rather than partially advanced.
	status, err := validator.Accept(0, k("a", "b", "z"), false)
	if !errors.Is(err, dataeng.ErrKeyOutsideInterval) {
		t.Fatalf("expected ErrKeyOutsideInterval, got %v", err)
	}
	if status != dataeng.StatusIncomplete {
		t.Fatalf("status = %s, want incomplete", status)
	}
	if got, _ := validator.Status(0); got != dataeng.StatusIncomplete {
		t.Fatalf("stored status = %s, want incomplete", got)
	}

	status, err = validator.Accept(0, k("a", "b"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusIncomplete {
		t.Fatalf("partial report status = %s, want incomplete", status)
	}

	status, err = validator.Accept(0, k("c", "m"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("final report status = %s, want complete", status)
	}
}

func TestLaterStartCannotReportOwnedOverlap(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
		{Start: []byte("d"), End: []byte("z")},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Worker 0 owns every key in [d, m] because it starts at "a".
	for _, key := range []string{"d", "m"} {
		status, err := validator.Accept(0, k(key), false)
		if err != nil {
			t.Fatalf("owner should report %q: %v", key, err)
		}
		if key == "m" && status != dataeng.StatusComplete {
			t.Fatalf("owner status = %s, want complete", status)
		}
	}

	// Worker 1 may not report any overlapping key.
	for _, key := range []string{"d", "m"} {
		status, err := validator.Accept(1, k(key), false)
		if !errors.Is(err, dataeng.ErrOverlappingKey) {
			t.Fatalf("worker 1 key %q: expected ErrOverlappingKey, got %v", key, err)
		}
		if status != dataeng.StatusIncomplete {
			t.Fatalf("worker 1 status = %s, want incomplete", status)
		}
	}
	if got, _ := validator.Status(1); got != dataeng.StatusIncomplete {
		t.Fatalf("stored worker 1 status = %s, want incomplete", got)
	}

	// The first key after the owner's end belongs to worker 1.
	status, err := validator.Accept(1, k("n", "z"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("worker 1 status = %s, want complete", status)
	}
}

func TestOwnershipUsesLatestEndOfEarlierIntervals(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("c")},
		{Start: []byte("b"), End: []byte("e")},
		{Start: []byte("d"), End: []byte("f")},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"d", "e"} {
		if _, err := validator.Accept(2, k(key), false); !errors.Is(err, dataeng.ErrOverlappingKey) {
			t.Fatalf("key %q should be owned by worker 1, got %v", key, err)
		}
	}
	status, err := validator.Accept(2, k("f"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("status = %s, want complete", status)
	}
}

func TestBoundaryOverlapBelongsToSmallerStart(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
		{Start: []byte("m"), End: []byte("z")},
	})
	if err != nil {
		t.Fatal(err)
	}

	// The shared boundary key belongs to worker 0.
	status, err := validator.Accept(0, k("a", "m"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("worker 0 status = %s, want complete", status)
	}
	if _, err := validator.Accept(1, k("m"), false); !errors.Is(err, dataeng.ErrOverlappingKey) {
		t.Fatalf("worker 1 should not report the shared boundary: %v", err)
	}

	status, err = validator.Accept(1, k("n", "z"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("worker 1 status = %s, want complete", status)
	}
}

func TestOwnershipDoesNotDependOnInputOrder(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("d"), End: []byte("z")},
		{Start: []byte("a"), End: []byte("m")},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Worker 1 has the smaller start even though it was listed second.
	if _, err := validator.Accept(0, k("d"), false); !errors.Is(err, dataeng.ErrOverlappingKey) {
		t.Fatalf("worker 0 should not report worker 1's overlap: %v", err)
	}
	status, err := validator.Accept(1, k("d", "m"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("worker 1 status = %s, want complete", status)
	}
}

func TestCompletionStateMachine(t *testing.T) {
	tests := []struct {
		name      string
		keys      []string
		exhausted bool
		status    dataeng.Status
		err       error
	}{
		{
			name:   "last key at end completes",
			keys:   []string{"a", "m"},
			status: dataeng.StatusComplete,
		},
		{
			name:      "exhausted below end completes",
			keys:      []string{"a", "c"},
			exhausted: true,
			status:    dataeng.StatusComplete,
		},
		{
			name:      "exhausted at end fails",
			keys:      []string{"a", "m"},
			exhausted: true,
			status:    dataeng.StatusFailed,
			err:       dataeng.ErrExhaustedAtEnd,
		},
		{
			name:   "partial without exhaustion stays incomplete",
			keys:   []string{"a", "c"},
			status: dataeng.StatusIncomplete,
		},
		{
			name:   "empty without exhaustion stays incomplete",
			status: dataeng.StatusIncomplete,
		},
		{
			name:      "empty with exhaustion completes",
			exhausted: true,
			status:    dataeng.StatusComplete,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, err := dataeng.NewValidator([]dataeng.Interval{
				{Start: []byte("a"), End: []byte("m")},
			})
			if err != nil {
				t.Fatal(err)
			}

			status, err := validator.Accept(0, k(test.keys...), test.exhausted)
			if test.err == nil && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if test.err != nil && !errors.Is(err, test.err) {
				t.Fatalf("error = %v, want %v", err, test.err)
			}
			if status != test.status {
				t.Fatalf("status = %s, want %s", status, test.status)
			}
			if got, _ := validator.Status(0); got != test.status {
				t.Fatalf("stored status = %s, want %s", got, test.status)
			}
		})
	}
}

func TestSingleKeyInterval(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("m"), End: []byte("m")},
	})
	if err != nil {
		t.Fatal(err)
	}

	status, err := validator.Accept(0, k("m"), false)
	if err != nil {
		t.Fatal(err)
	}
	if status != dataeng.StatusComplete {
		t.Fatalf("status = %s, want complete", status)
	}

	failing, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("m"), End: []byte("m")},
	})
	if err != nil {
		t.Fatal(err)
	}
	status, err = failing.Accept(0, k("m"), true)
	if !errors.Is(err, dataeng.ErrExhaustedAtEnd) {
		t.Fatalf("expected ErrExhaustedAtEnd, got %v", err)
	}
	if status != dataeng.StatusFailed {
		t.Fatalf("status = %s, want failed", status)
	}
}

func TestFinalIntervalsRejectFurtherReports(t *testing.T) {
	tests := []struct {
		name      string
		keys      []string
		exhausted bool
	}{
		{name: "complete", keys: []string{"m"}},
		{name: "failed", keys: []string{"m"}, exhausted: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validator, err := dataeng.NewValidator([]dataeng.Interval{
				{Start: []byte("a"), End: []byte("m")},
			})
			if err != nil {
				t.Fatal(err)
			}
			// The failed case deliberately returns ErrExhaustedAtEnd; the
			// point of this test is the rejection of later reports.
			_, _ = validator.Accept(0, k(test.keys...), test.exhausted)
			status, err := validator.Accept(0, k("a"), false)
			if !errors.Is(err, dataeng.ErrIntervalFinal) {
				t.Fatalf("expected ErrIntervalFinal, got %v", err)
			}
			if status != dataeng.StatusComplete && status != dataeng.StatusFailed {
				t.Fatalf("unexpected final status %s", status)
			}
		})
	}
}

func TestReportHelpersAndUnknownWorker(t *testing.T) {
	validator, err := dataeng.NewValidator([]dataeng.Interval{
		{Start: []byte("a"), End: []byte("m")},
	})
	if err != nil {
		t.Fatal(err)
	}

	report := dataeng.Report{Keys: k("a", "b"), Exhausted: true}
	if status, err := validator.ValidateReport(0, report); err != nil || status != dataeng.StatusComplete {
		t.Fatalf("ValidateReport = (%s, %v), want (complete, nil)", status, err)
	}
	if got, _ := validator.Status(0); got != dataeng.StatusIncomplete {
		t.Fatalf("ValidateReport changed state to %s", got)
	}

	if status, err := validator.AcceptReport(0, report); err != nil || status != dataeng.StatusComplete {
		t.Fatalf("AcceptReport = (%s, %v), want (complete, nil) ", status, err)
	}
	if _, err := validator.Accept(99, nil, false); !errors.Is(err, dataeng.ErrUnknownWorker) {
		t.Fatalf("expected ErrUnknownWorker, got %v", err)
	}
	if _, ok := validator.Interval(99); ok {
		t.Fatal("expected missing interval")
	}

	status, err := dataeng.ValidateReport(
		dataeng.Interval{Start: []byte("a"), End: []byte("m")},
		k("m"),
		true,
	)
	if !errors.Is(err, dataeng.ErrExhaustedAtEnd) || status != dataeng.StatusFailed {
		t.Fatalf("ValidateReport = (%s, %v), want (failed, ErrExhaustedAtEnd)", status, err)
	}
}

func TestConstructorCopiesIntervals(t *testing.T) {
	start := []byte("a")
	end := []byte("m")
	validator, err := dataeng.NewValidator([]dataeng.Interval{{Start: start, End: end}})
	if err != nil {
		t.Fatal(err)
	}
	start[0] = 'z'
	end[0] = 'z'

	interval, ok := validator.Interval(0)
	if !ok {
		t.Fatal("missing interval")
	}
	if string(interval.Start) != "a" || string(interval.End) != "m" {
		t.Fatalf("constructor did not copy interval: %s", interval)
	}
	if status, err := validator.Accept(0, k("a", "m"), false); err != nil || status != dataeng.StatusComplete {
		t.Fatalf("Accept = (%s, %v), want (complete, nil)", status, err)
	}
}
