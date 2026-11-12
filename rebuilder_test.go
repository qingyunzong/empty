package dataeng_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"example.org/dataeng/q0025"
)

// encodeRows is an independent reference encoder: it turns reconstructed rows
// back into repetition/definition levels and a value stream, without reusing
// any production code paths.
func encodeRows(rows []dataeng.Row) ([]dataeng.Level, []int64) {
	var levels []dataeng.Level
	var values []int64
	for _, row := range rows {
		if row.Null {
			levels = append(levels, dataeng.Level{Repetition: 0, Definition: 0})
			continue
		}
		if len(row.Elems) == 0 {
			levels = append(levels, dataeng.Level{Repetition: 0, Definition: 1})
			continue
		}
		for index, elem := range row.Elems {
			repetition := 1
			if index == 0 {
				repetition = 0
			}
			if elem == nil {
				levels = append(levels, dataeng.Level{Repetition: repetition, Definition: 2})
				continue
			}
			levels = append(levels, dataeng.Level{Repetition: repetition, Definition: 3})
			values = append(values, *elem)
		}
	}
	return levels, values
}

func chunkLevels(in []dataeng.Level, size int) [][]dataeng.Level {
	var out [][]dataeng.Level
	for start := 0; start < len(in); start += size {
		end := start + size
		if end > len(in) {
			end = len(in)
		}
		out = append(out, in[start:end])
	}
	return out
}

func chunkValues(in []int64, size int) [][]int64 {
	var out [][]int64
	for start := 0; start < len(in); start += size {
		end := start + size
		if end > len(in) {
			end = len(in)
		}
		out = append(out, in[start:end])
	}
	return out
}

func intPtr(v int64) *int64 { return &v }

func rowsEqual(got, want []dataeng.Row) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].Null != want[i].Null {
			return false
		}
		if got[i].Null {
			continue
		}
		if len(got[i].Elems) != len(want[i].Elems) {
			return false
		}
		for j := range got[i].Elems {
			gotElem, wantElem := got[i].Elems[j], want[i].Elems[j]
			if (gotElem == nil) != (wantElem == nil) {
				return false
			}
			if gotElem != nil && *gotElem != *wantElem {
				return false
			}
		}
	}
	return true
}

type memTx struct {
	rows       []dataeng.Row
	stageErr   error
	commitErr  error
	commits    int
	rolledBack bool
	committed  bool
}

func (t *memTx) Stage(row dataeng.Row) error {
	if t.stageErr != nil {
		return t.stageErr
	}
	t.rows = append(t.rows, row)
	return nil
}

func (t *memTx) Commit() error {
	t.commits++
	if t.commitErr != nil {
		return t.commitErr
	}
	t.committed = true
	return nil
}

func (t *memTx) Rollback() error {
	t.rolledBack = true
	return nil
}

type memSink struct {
	tx       *memTx
	beginErr error
	begins   int
}

func (s *memSink) Begin() (dataeng.Transaction, error) {
	s.begins++
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	return s.tx, nil
}

func newHarness(commitErr, stageErr error) (*memSink, *memTx) {
	tx := &memTx{commitErr: commitErr, stageErr: stageErr}
	return &memSink{tx: tx}, tx
}

func feed(ctx context.Context, t *testing.T, r *dataeng.Rebuilder, levelChunks [][]dataeng.Level, valueChunks [][]int64) {
	t.Helper()
	for _, chunk := range levelChunks {
		if err := r.AppendLevels(ctx, chunk); err != nil {
			t.Fatalf("AppendLevels: %v", err)
		}
	}
	for _, chunk := range valueChunks {
		if err := r.AppendValues(ctx, chunk); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
	}
	if err := r.SealLevels(ctx); err != nil {
		t.Fatalf("SealLevels: %v", err)
	}
	if err := r.SealValues(ctx); err != nil {
		t.Fatalf("SealValues: %v", err)
	}
}

func longRows() []dataeng.Row {
	const listLen = 500
	elems := make([]*int64, listLen)
	var next int64
	for i := range elems {
		if i%2 == 0 {
			elems[i] = intPtr(next)
			next++
		}
	}
	return []dataeng.Row{
		{Elems: elems},
		{Null: true},
		{Elems: []*int64{}},
		{Elems: []*int64{intPtr(1000), nil, intPtr(1001)}},
		{Null: true},
	}
}

func TestCrossChunkLongList(t *testing.T) {
	ctx := context.Background()
	want := longRows()
	levels, values := encodeRows(want)

	for _, levelSize := range []int{1, 3, 37, 100, len(levels)} {
		for _, valueSize := range []int{1, 5, 64, len(values)} {
			name := fmt.Sprintf("levels=%d/values=%d", levelSize, valueSize)
			t.Run(name, func(t *testing.T) {
				sink, tx := newHarness(nil, nil)
				r, err := dataeng.NewRebuilder(sink)
				if err != nil {
					t.Fatalf("NewRebuilder: %v", err)
				}

				feed(ctx, t, r,
					chunkLevels(levels, levelSize),
					chunkValues(values, valueSize))

				state, err := r.Wait(ctx)
				if state != dataeng.StateCommitted || err != nil {
					t.Fatalf("state=%s err=%v, want committed", state, err)
				}
				if !rowsEqual(tx.rows, want) {
					t.Fatalf("reconstructed rows differ (got %d rows, want %d)", len(tx.rows), len(want))
				}
				if tx.commits != 1 || tx.rolledBack || sink.begins != 1 {
					t.Fatalf("tx commits=%d rolledBack=%v begins=%d", tx.commits, tx.rolledBack, sink.begins)
				}
				if got := r.Result().Rows; got != len(want) {
					t.Fatalf("Result().Rows=%d, want %d", got, len(want))
				}
			})
		}
	}
}

func TestValueLate(t *testing.T) {
	ctx := context.Background()
	want := []dataeng.Row{
		{Elems: []*int64{intPtr(10)}},
		{Elems: []*int64{intPtr(20), nil, intPtr(21)}},
		{Null: true},
	}
	levels, values := encodeRows(want)

	t.Run("levels sealed first, values arrive one at a time", func(t *testing.T) {
		sink, tx := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}

		for _, chunk := range chunkLevels(levels, 2) {
			if err := r.AppendLevels(ctx, chunk); err != nil {
				t.Fatalf("AppendLevels: %v", err)
			}
		}
		if state := r.Result().State; state != dataeng.StateOpen {
			t.Fatalf("state before sealing levels = %s, want open", state)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}
		if res := r.Result(); res.Rows != 0 || res.State != dataeng.StateOpen {
			t.Fatalf("rebuild advanced before values arrived: %+v", res)
		}

		for index, value := range values {
			if err := r.AppendValues(ctx, []int64{value}); err != nil {
				t.Fatalf("AppendValues #%d: %v", index, err)
			}
		}
		if state := r.Result().State; state != dataeng.StateOpen {
			t.Fatalf("state before sealing values = %s, want open", state)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues: %v", err)
		}

		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed", state, err)
		}
		if !rowsEqual(tx.rows, want) {
			t.Fatalf("reconstructed rows differ: %#v", tx.rows)
		}
		if err := r.AppendLevels(ctx, nil); !errors.Is(err, dataeng.ErrTerminal) {
			t.Fatalf("append after commit err=%v, want ErrTerminal", err)
		}
		if err := r.SealValues(ctx); !errors.Is(err, dataeng.ErrTerminal) {
			t.Fatalf("re-seal after commit err=%v, want ErrTerminal", err)
		}
	})

	t.Run("values buffered before any levels", func(t *testing.T) {
		sink, tx := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.AppendValues(ctx, values); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
		feed(ctx, t, r, chunkLevels(levels, 4), nil)

		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed", state, err)
		}
		if !rowsEqual(tx.rows, want) {
			t.Fatalf("reconstructed rows differ: %#v", tx.rows)
		}
	})

	t.Run("sealed level stream stays open until late value arrives", func(t *testing.T) {
		sink, _ := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.AppendLevels(ctx, []dataeng.Level{{Repetition: 0, Definition: 3}}); err != nil {
			t.Fatalf("AppendLevels: %v", err)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}

		waitCtx, cancel := context.WithCancel(ctx)
		done := make(chan dataeng.State, 1)
		go func() {
			state, _ := r.Wait(waitCtx)
			done <- state
		}()
		cancel()
		if state := <-done; state != dataeng.StateOpen {
			t.Fatalf("Wait returned state=%s while value missing, want open", state)
		}

		if err := r.AppendValues(ctx, []int64{77}); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues: %v", err)
		}
		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed after late value", state, err)
		}
	})
}

func TestIllegalContinuation(t *testing.T) {
	ctx := context.Background()

	legalCases := []struct {
		name   string
		levels []dataeng.Level
		values []int64
		want   dataeng.Row
	}{
		{
			name:   "continue non-null list with null",
			levels: []dataeng.Level{{0, 2}, {1, 2}},
			want:   dataeng.Row{Elems: []*int64{nil, nil}},
		},
		{
			name:   "empty list continues into non-null element",
			levels: []dataeng.Level{{0, 1}, {1, 3}},
			values: []int64{9},
			want:   dataeng.Row{Elems: []*int64{intPtr(9)}},
		},
		{
			name:   "mixed continuation",
			levels: []dataeng.Level{{0, 3}, {1, 2}, {1, 3}, {1, 2}},
			values: []int64{1, 2},
			want:   dataeng.Row{Elems: []*int64{intPtr(1), nil, intPtr(2), nil}},
		},
	}
	for _, tc := range legalCases {
		t.Run("legal/"+tc.name, func(t *testing.T) {
			sink, tx := newHarness(nil, nil)
			r, err := dataeng.NewRebuilder(sink)
			if err != nil {
				t.Fatalf("NewRebuilder: %v", err)
			}
			feed(ctx, t, r,
				chunkLevels(tc.levels, 1),
				chunkValues(tc.values, 1))
			state, err := r.Wait(ctx)
			if state != dataeng.StateCommitted || err != nil {
				t.Fatalf("state=%s err=%v, want committed", state, err)
			}
			if !rowsEqual(tx.rows, []dataeng.Row{tc.want}) {
				t.Fatalf("row=%#v, want %#v", tx.rows, tc.want)
			}
		})
	}

	illegalCases := []struct {
		name    string
		levels  []dataeng.Level
		wantErr error
	}{
		{
			name:    "continuation before any row",
			levels:  []dataeng.Level{{1, 2}},
			wantErr: dataeng.ErrIllegalContinuation,
		},
		{
			name:    "continuation of null list",
			levels:  []dataeng.Level{{0, 0}, {1, 2}},
			wantErr: dataeng.ErrIllegalContinuation,
		},
		{
			name:    "continuation with definition 1",
			levels:  []dataeng.Level{{0, 2}, {1, 1}},
			wantErr: dataeng.ErrInvalidLevel,
		},
		{
			name:    "continuation with definition 0",
			levels:  []dataeng.Level{{0, 2}, {1, 0}},
			wantErr: dataeng.ErrInvalidLevel,
		},
		{
			name:    "definition 4 at new row",
			levels:  []dataeng.Level{{0, 4}},
			wantErr: dataeng.ErrInvalidLevel,
		},
		{
			name:    "repetition 2",
			levels:  []dataeng.Level{{2, 2}},
			wantErr: dataeng.ErrInvalidLevel,
		},
	}
	for _, tc := range illegalCases {
		t.Run("illegal/"+tc.name, func(t *testing.T) {
			sink, tx := newHarness(nil, nil)
			r, err := dataeng.NewRebuilder(sink)
			if err != nil {
				t.Fatalf("NewRebuilder: %v", err)
			}

			var appendErr error
			for _, level := range tc.levels {
				if appendErr = r.AppendLevels(ctx, []dataeng.Level{level}); appendErr != nil {
					break
				}
			}
			if appendErr == nil {
				appendErr = r.SealLevels(ctx)
			}
			if !errors.Is(appendErr, tc.wantErr) {
				t.Fatalf("err=%v, want %v", appendErr, tc.wantErr)
			}
			_ = r.SealValues(ctx)
			state, err := r.Wait(ctx)
			if state != dataeng.StateFailed || !errors.Is(err, tc.wantErr) {
				t.Fatalf("state=%s err=%v, want failed with %v", state, err, tc.wantErr)
			}
			if !tx.rolledBack || tx.commits != 0 || len(tx.rows) != 0 {
				t.Fatalf("tx rolledBack=%v commits=%d rows=%d, want rollback with no commit",
					tx.rolledBack, tx.commits, len(tx.rows))
			}
		})
	}
}

func TestTruncation(t *testing.T) {
	ctx := context.Background()

	t.Run("value stream ends while definition 3 waits", func(t *testing.T) {
		sink, tx := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.AppendLevels(ctx, []dataeng.Level{{0, 3}, {1, 3}}); err != nil {
			t.Fatalf("AppendLevels: %v", err)
		}
		if err := r.AppendValues(ctx, []int64{1}); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}
		err = r.SealValues(ctx)
		if !errors.Is(err, dataeng.ErrMissingValue) {
			t.Fatalf("SealValues err=%v, want ErrMissingValue", err)
		}
		state, err := r.Wait(ctx)
		if state != dataeng.StateFailed || !errors.Is(err, dataeng.ErrMissingValue) {
			t.Fatalf("state=%s err=%v, want failed missing value", state, err)
		}
		if !tx.rolledBack || tx.commits != 0 {
			t.Fatalf("rolledBack=%v commits=%d, want rollback and no commit", tx.rolledBack, tx.commits)
		}
	})

	t.Run("extra values after level stream ends", func(t *testing.T) {
		sink, tx := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.AppendLevels(ctx, []dataeng.Level{{0, 3}}); err != nil {
			t.Fatalf("AppendLevels: %v", err)
		}
		if err := r.AppendValues(ctx, []int64{5, 6}); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues: %v", err)
		}
		err = r.SealLevels(ctx)
		if !errors.Is(err, dataeng.ErrExtraValue) {
			t.Fatalf("SealLevels err=%v, want ErrExtraValue", err)
		}
		state, _ := r.Wait(ctx)
		if state != dataeng.StateFailed {
			t.Fatalf("state=%s, want failed", state)
		}
		if !tx.rolledBack || tx.commits != 0 {
			t.Fatalf("rolledBack=%v commits=%d rows=%d, want rollback without commit",
				tx.rolledBack, tx.commits, len(tx.rows))
		}
	})

	t.Run("append after seal is rejected", func(t *testing.T) {
		sink, _ := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}
		if err := r.AppendLevels(ctx, []dataeng.Level{{0, 1}}); !errors.Is(err, dataeng.ErrAlreadySealed) {
			t.Fatalf("AppendLevels err=%v, want ErrAlreadySealed", err)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues: %v", err)
		}
		if err := r.AppendValues(ctx, []int64{1}); !errors.Is(err, dataeng.ErrTerminal) {
			t.Fatalf("AppendValues err=%v, want ErrTerminal after commit", err)
		}
		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed empty input", state, err)
		}
	})

	t.Run("re-sealing an open stream is rejected before commit", func(t *testing.T) {
		sink, _ := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}
		if err := r.SealLevels(ctx); !errors.Is(err, dataeng.ErrAlreadySealed) {
			t.Fatalf("re-seal levels err=%v, want ErrAlreadySealed", err)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues empty: %v", err)
		}
		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed empty input", state, err)
		}
	})

	t.Run("double value seal is rejected", func(t *testing.T) {
		sink, _ := newHarness(nil, nil)
		r, err := dataeng.NewRebuilder(sink)
		if err != nil {
			t.Fatalf("NewRebuilder: %v", err)
		}
		if err := r.SealValues(ctx); err != nil {
			t.Fatalf("SealValues: %v", err)
		}
		if err := r.SealValues(ctx); !errors.Is(err, dataeng.ErrAlreadySealed) {
			t.Fatalf("re-seal values err=%v, want ErrAlreadySealed", err)
		}
		if err := r.SealLevels(ctx); err != nil {
			t.Fatalf("SealLevels empty: %v", err)
		}
		state, err := r.Wait(ctx)
		if state != dataeng.StateCommitted || err != nil {
			t.Fatalf("state=%s err=%v, want committed empty input", state, err)
		}
	})
}

func TestEmptyInput(t *testing.T) {
	ctx := context.Background()
	sink, tx := newHarness(nil, nil)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	if err := r.AppendLevels(ctx, nil); err != nil {
		t.Fatalf("empty AppendLevels: %v", err)
	}
	if err := r.AppendValues(ctx, nil); err != nil {
		t.Fatalf("empty AppendValues: %v", err)
	}
	if err := r.SealLevels(ctx); err != nil {
		t.Fatalf("SealLevels: %v", err)
	}
	if err := r.SealValues(ctx); err != nil {
		t.Fatalf("SealValues: %v", err)
	}

	state, err := r.Wait(ctx)
	if state != dataeng.StateCommitted || err != nil {
		t.Fatalf("state=%s err=%v, want committed", state, err)
	}
	if len(tx.rows) != 0 || tx.commits != 1 || tx.rolledBack {
		t.Fatalf("rows=%d commits=%d rolledBack=%v, want zero rows committed once",
			len(tx.rows), tx.commits, tx.rolledBack)
	}
	if res := r.Result(); res.Rows != 0 || res.State != dataeng.StateCommitted || res.Transaction != nil {
		t.Fatalf("unexpected result for empty input: %+v", res)
	}
}

func TestCommitUnknown(t *testing.T) {
	ctx := context.Background()
	sink, tx := newHarness(dataeng.ErrCommitUnknown, nil)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	levels, values := encodeRows([]dataeng.Row{{Elems: []*int64{intPtr(1), nil}}})
	feed(ctx, t, r, chunkLevels(levels, 1), chunkValues(values, 1))

	state, err := r.Wait(ctx)
	if state != dataeng.StateNeedsConfirmation || !errors.Is(err, dataeng.ErrCommitUnknown) {
		t.Fatalf("state=%s err=%v, want needs confirmation", state, err)
	}
	if tx.commits != 1 || tx.rolledBack {
		t.Fatalf("commits=%d rolledBack=%v, want exactly one commit attempt and no rollback",
			tx.commits, tx.rolledBack)
	}
	res := r.Result()
	if res.Transaction != dataeng.Transaction(tx) {
		t.Fatalf("Result().Transaction not retained for confirmation")
	}

	if err := r.AppendLevels(ctx, nil); !errors.Is(err, dataeng.ErrTerminal) {
		t.Fatalf("append after unknown commit err=%v, want ErrTerminal", err)
	}
	if err := r.SealValues(ctx); !errors.Is(err, dataeng.ErrTerminal) {
		t.Fatalf("seal after unknown commit err=%v, want ErrTerminal", err)
	}
}

func TestCommitFailure(t *testing.T) {
	ctx := context.Background()
	commitErr := errors.New("broker unavailable")
	sink, tx := newHarness(commitErr, nil)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	levels, values := encodeRows([]dataeng.Row{{Null: true}, {Elems: []*int64{intPtr(4)}}})
	for _, chunk := range chunkLevels(levels, 2) {
		if err := r.AppendLevels(ctx, chunk); err != nil {
			t.Fatalf("AppendLevels: %v", err)
		}
	}
	for _, chunk := range chunkValues(values, 1) {
		if err := r.AppendValues(ctx, chunk); err != nil {
			t.Fatalf("AppendValues: %v", err)
		}
	}
	if err := r.SealLevels(ctx); err != nil {
		t.Fatalf("SealLevels: %v", err)
	}
	if err := r.SealValues(ctx); !errors.Is(err, commitErr) {
		t.Fatalf("SealValues err=%v, want commit error", err)
	}

	state, err := r.Wait(ctx)
	if state != dataeng.StateFailed || !errors.Is(err, commitErr) {
		t.Fatalf("state=%s err=%v, want failed wrapped commit error", state, err)
	}
	if tx.commits != 1 || !tx.rolledBack || len(tx.rows) != 2 {
		t.Fatalf("commits=%d rolledBack=%v rows=%d, want one commit, rollback, staged rows",
			tx.commits, tx.rolledBack, len(tx.rows))
	}
	if err := r.AppendValues(ctx, nil); !errors.Is(err, commitErr) {
		t.Fatalf("append after failure err=%v, want sticky commit error", err)
	}
}

func TestStageFailure(t *testing.T) {
	ctx := context.Background()
	stageErr := errors.New("staging buffer full")
	sink, tx := newHarness(nil, stageErr)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	levels, _ := encodeRows([]dataeng.Row{{Null: true}, {Null: true}})
	var firstErr error
	for _, chunk := range chunkLevels(levels, 1) {
		if appendErr := r.AppendLevels(ctx, chunk); appendErr != nil && firstErr == nil {
			firstErr = appendErr
		}
	}
	if firstErr == nil {
		firstErr = r.SealLevels(ctx)
	}
	if !errors.Is(firstErr, stageErr) {
		t.Fatalf("first error=%v, want stage error", firstErr)
	}
	if err := r.SealValues(ctx); !errors.Is(err, stageErr) {
		t.Fatalf("SealValues err=%v, want sticky stage error", err)
	}
	state, err := r.Wait(ctx)
	if state != dataeng.StateFailed || !errors.Is(err, stageErr) {
		t.Fatalf("state=%s err=%v, want failed stage error", state, err)
	}
	if tx.commits != 0 || !tx.rolledBack {
		t.Fatalf("commits=%d rolledBack=%v, want no commit and rollback", tx.commits, tx.rolledBack)
	}
}

func TestBeginFailure(t *testing.T) {
	beginErr := errors.New("sink down")
	sink := &memSink{beginErr: beginErr}
	if _, err := dataeng.NewRebuilder(sink); !errors.Is(err, beginErr) {
		t.Fatalf("NewRebuilder err=%v, want begin error", err)
	}
	if _, err := dataeng.NewRebuilder(nil); err == nil {
		t.Fatalf("NewRebuilder(nil) err=nil, want error")
	}
}

func TestConcurrentAppends(t *testing.T) {
	ctx := context.Background()
	want := longRows()
	levels, values := encodeRows(want)

	sink, tx := newHarness(nil, nil)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for _, chunk := range chunkLevels(levels, 7) {
			if appendErr := r.AppendLevels(ctx, chunk); appendErr != nil {
				t.Errorf("AppendLevels: %v", appendErr)
				return
			}
		}
		if sealErr := r.SealLevels(ctx); sealErr != nil {
			t.Errorf("SealLevels: %v", sealErr)
		}
	}()
	go func() {
		defer wg.Done()
		for _, chunk := range chunkValues(values, 3) {
			if appendErr := r.AppendValues(ctx, chunk); appendErr != nil {
				t.Errorf("AppendValues: %v", appendErr)
				return
			}
		}
		if sealErr := r.SealValues(ctx); sealErr != nil {
			t.Errorf("SealValues: %v", sealErr)
		}
	}()

	state, err := r.Wait(ctx)
	wg.Wait()
	if state != dataeng.StateCommitted || err != nil {
		t.Fatalf("state=%s err=%v, want committed", state, err)
	}
	if !rowsEqual(tx.rows, want) {
		t.Fatalf("concurrent rebuild produced %d rows, want %d", len(tx.rows), len(want))
	}
}

func TestStateString(t *testing.T) {
	cases := map[dataeng.State]string{
		dataeng.StateOpen:              "open",
		dataeng.StateCommitted:         "committed",
		dataeng.StateNeedsConfirmation: "needs_confirmation",
		dataeng.StateFailed:            "failed",
		dataeng.State(99):              "unknown",
	}
	for state, want := range cases {
		if got := state.String(); got != want {
			t.Fatalf("State(%d).String()=%q, want %q", state, got, want)
		}
	}
}

func TestContextCancellation(t *testing.T) {
	sink, _ := newHarness(nil, nil)
	r, err := dataeng.NewRebuilder(sink)
	if err != nil {
		t.Fatalf("NewRebuilder: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := r.AppendLevels(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("AppendLevels err=%v, want context.Canceled", err)
	}
	if err := r.AppendValues(ctx, []int64{1}); !errors.Is(err, context.Canceled) {
		t.Fatalf("AppendValues err=%v, want context.Canceled", err)
	}
	if err := r.SealLevels(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("SealLevels err=%v, want context.Canceled", err)
	}
	if err := r.SealValues(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("SealValues err=%v, want context.Canceled", err)
	}

	if res := r.Result(); res.State != dataeng.StateOpen || res.Err != nil || res.Rows != 0 {
		t.Fatalf("result=%+v, want still open after canceled calls", res)
	}
	waitCtx, waitCancel := context.WithCancel(context.Background())
	go func() {
		waitCancel()
	}()
	if state, waitErr := r.Wait(waitCtx); state != dataeng.StateOpen || !errors.Is(waitErr, context.Canceled) {
		t.Fatalf("Wait state=%s err=%v, want open with context.Canceled", state, waitErr)
	}

	levels, values := encodeRows([]dataeng.Row{{Elems: []*int64{intPtr(3)}}})
	feedLevelsOnly := func(levelChunks [][]dataeng.Level) {
		t.Helper()
		for _, chunk := range levelChunks {
			if err := r.AppendLevels(context.Background(), chunk); err != nil {
				t.Fatalf("AppendLevels: %v", err)
			}
		}
		if err := r.SealLevels(context.Background()); err != nil {
			t.Fatalf("SealLevels: %v", err)
		}
	}
	feedLevelsOnly(chunkLevels(levels, 1))
	if err := r.AppendValues(context.Background(), values); err != nil {
		t.Fatalf("AppendValues after canceled calls: %v", err)
	}
	if err := r.SealValues(context.Background()); err != nil {
		t.Fatalf("SealValues: %v", err)
	}
	state, err := r.Wait(context.Background())
	if state != dataeng.StateCommitted || err != nil {
		t.Fatalf("state=%s err=%v, want committed", state, err)
	}
}
