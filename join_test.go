package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func rows(keys ...any) []Row {
	out := make([]Row, 0, len(keys))
	for _, k := range keys {
		switch v := k.(type) {
		case int64:
			out = append(out, Row{Key: Key{Int(v)}, Val: v})
		case string:
			out = append(out, Row{Key: Key{Str(v)}, Val: v})
		case nil:
			out = append(out, Row{Key: Key{Null()}, Val: "nil"})
		}
	}
	return out
}

func dupRows(key int64, n int, prefix string) []Row {
	out := make([]Row, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, Row{Key: Key{Int(key)}, Val: fmt.Sprintf("%s-%d", prefix, i)})
	}
	return out
}

func pairVals(p Pair) (any, any) { return p.Left.Val, p.Right.Val }

func TestInnerJoinChunked(t *testing.T) {
	left := rows(int64(1), int64(2), int64(2), int64(4))
	right := rows(int64(2), int64(2), int64(3), int64(4))
	j, err := NewJoiner(NewSliceSource(left, 1), NewSliceSource(right, 2), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	pairs, err := j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 5 { // 2x2 for key 2, plus 1 for key 4
		t.Fatalf("got %d pairs, want 5", len(pairs))
	}
	for _, p := range pairs[:4] {
		l, r := pairVals(p)
		if l.(int64) != 2 || r.(int64) != 2 {
			t.Fatalf("unexpected pair %v %v", l, r)
		}
	}
	if l, r := pairVals(pairs[4]); l.(int64) != 4 || r.(int64) != 4 {
		t.Fatalf("unexpected last pair %v %v", l, r)
	}
}

func TestSpilledGroupCartesianOrder(t *testing.T) {
	const nl, nr = 50, 30
	left := append(dupRows(7, nl, "L"), Row{Key: Key{Int(9)}, Val: "tail"})
	right := append(dupRows(7, nr, "R"), Row{Key: Key{Int(9)}, Val: "tail"})
	j, err := NewJoiner(NewSliceSource(left, 7), NewSliceSource(right, 3),
		Options{MaxGroupRows: 8})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	pairs, err := j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != nl*nr+1 {
		t.Fatalf("got %d pairs, want %d", len(pairs), nl*nr+1)
	}
	// Left-major order, both sides in input order.
	for i := 0; i < nl; i++ {
		for k := 0; k < nr; k++ {
			p := pairs[i*nr+k]
			if p.Left.Val != fmt.Sprintf("L-%d", i) || p.Right.Val != fmt.Sprintf("R-%d", k) {
				t.Fatalf("pair %d: got %v x %v", i*nr+k, p.Left.Val, p.Right.Val)
			}
		}
	}
	if pairs[nl*nr].Left.Val != "tail" {
		t.Fatal("missing trailing group")
	}
}

func TestSpillOneSideOnly(t *testing.T) {
	left := dupRows(1, 25, "L")
	right := dupRows(1, 3, "R")
	j, err := NewJoiner(NewSliceSource(left, 5), NewSliceSource(right, 2),
		Options{MaxGroupRows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	pairs, err := j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 75 {
		t.Fatalf("got %d pairs, want 75", len(pairs))
	}
	for i := 0; i < 25; i++ {
		for k := 0; k < 3; k++ {
			p := pairs[i*3+k]
			if p.Left.Val != fmt.Sprintf("L-%d", i) || p.Right.Val != fmt.Sprintf("R-%d", k) {
				t.Fatalf("pair %d out of order: %v x %v", i*3+k, p.Left.Val, p.Right.Val)
			}
		}
	}
}

func TestNullModes(t *testing.T) {
	left := rows(nil, int64(1))
	right := rows(nil, int64(1))

	j, _ := NewJoiner(NewSliceSource(left, 4), NewSliceSource(right, 4), Options{Mode: ModeInner})
	pairs, err := j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	if len(pairs) != 1 || pairs[0].Left.Val.(int64) != 1 {
		t.Fatalf("inner mode: got %v pairs, want only key=1", len(pairs))
	}

	j, _ = NewJoiner(NewSliceSource(left, 4), NewSliceSource(right, 4), Options{Mode: ModeNullSafe})
	pairs, err = j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	j.Close()
	if len(pairs) != 2 {
		t.Fatalf("null-safe mode: got %d pairs, want 2", len(pairs))
	}
	if !pairs[0].Key.HasNull() {
		t.Fatal("null-safe mode: first pair should be the NULL key group")
	}
}

func TestCancelKeepsCommittedBatches(t *testing.T) {
	dir := t.TempDir()
	mgr, err := NewSpillManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Two spilling groups: key 1 and key 2.
	left := append(dupRows(1, 20, "L1"), dupRows(2, 20, "L2")...)
	right := append(dupRows(1, 20, "R1"), dupRows(2, 20, "R2")...)
	j, err := NewJoiner(NewSliceSource(left, 3), NewSliceSource(right, 3),
		Options{MaxGroupRows: 4, Manager: mgr})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// Drain the first group fully; the 401st call commits its spill
	// transaction and yields the first pair of the second group.
	for i := 0; i < 401; i++ {
		if _, err := j.Next(ctx); err != nil {
			t.Fatal(err)
		}
	}
	committed := mgr.CommittedFiles()
	if len(committed) == 0 {
		t.Fatal("expected committed spill batches after first group")
	}
	// Cancel mid-way through the second group.
	if err := j.Abort(); err != nil {
		t.Fatal(err)
	}
	// Committed batches survive; uncommitted spill is gone.
	for _, f := range committed {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("committed batch %s removed on cancel", f)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(committed) {
		t.Fatalf("spill dir holds %d files, want %d committed only", len(entries), len(committed))
	}
	if err := mgr.Close(); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("Close should remove committed batches, %d remain", len(entries))
	}
}

func TestCloseCleansOwnedSpill(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "spill")
	left := dupRows(1, 30, "L")
	right := dupRows(1, 30, "R")
	j, err := NewJoiner(NewSliceSource(left, 4), NewSliceSource(right, 4),
		Options{MaxGroupRows: 4, SpillDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Collect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("Close left %d spill files", len(entries))
	}
}

func TestSpillReaderResume(t *testing.T) {
	mgr, err := NewSpillManager("")
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	txn, _ := mgr.Begin()
	w, err := txn.Writer()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if err := w.Write(Row{Key: Key{Int(int64(i))}, Val: i}); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	txn.Commit()

	r, err := OpenSpillReader(w.Path())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if _, err := r.Next(); err != nil {
			t.Fatal(err)
		}
	}
	off := r.Offset()
	r.Close()

	// Resume from the recorded offset.
	r2, err := OpenSpillReaderAt(w.Path(), off)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Close()
	for i := 4; i < 10; i++ {
		row, err := r2.Next()
		if err != nil {
			t.Fatal(err)
		}
		if row.Val.(int) != i {
			t.Fatalf("resumed row %d: got %v", i, row.Val)
		}
	}
	if _, err := r2.Next(); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestUnsortedDetected(t *testing.T) {
	left := rows(int64(2), int64(1))
	right := rows(int64(2), int64(3))
	j, _ := NewJoiner(NewSliceSource(left, 2), NewSliceSource(right, 1), Options{})
	defer j.Close()
	_, err := j.Collect(context.Background())
	if !errors.Is(err, ErrUnsorted) {
		t.Fatalf("got %v, want ErrUnsorted", err)
	}
}

func TestCompositeKeys(t *testing.T) {
	mk := func(a int64, b string) Row {
		return Row{Key: Key{Int(a), Str(b)}, Val: fmt.Sprintf("%d/%s", a, b)}
	}
	left := []Row{mk(1, "a"), mk(1, "b"), mk(2, "a")}
	right := []Row{mk(1, "b"), mk(2, "a"), mk(2, "b")}
	j, _ := NewJoiner(NewSliceSource(left, 1), NewSliceSource(right, 1), Options{})
	defer j.Close()
	pairs, err := j.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 2 {
		t.Fatalf("got %d pairs, want 2", len(pairs))
	}
	if pairs[0].Left.Val != "1/b" || pairs[1].Left.Val != "2/a" {
		t.Fatalf("wrong matches: %v, %v", pairs[0].Left.Val, pairs[1].Left.Val)
	}
}
