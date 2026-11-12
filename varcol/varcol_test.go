package varcol_test

import (
	"bytes"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"example.org/dataeng/q0083/varcol"
)

func setNull(validity []byte, row int) []byte {
	if validity == nil {
		validity = make([]byte, (row+8)/8)
		for i := range validity {
			validity[i] = 0xFF
		}
	}
	validity[row/8] &^= 1 << uint(row%8)
	return validity
}

func TestNewValidation(t *testing.T) {
	data := []byte("abcdef")
	good := []int32{0, 1, 3, 6}

	cases := []struct {
		name     string
		data     []byte
		offsets  []int32
		validity []byte
		rows     int
	}{
		{"negative rows", data, good, nil, -1},
		{"offsets length mismatch", data, []int32{0, 1, 3}, nil, 3},
		{"offset out of bounds", data, []int32{0, 1, 9}, nil, 2},
		{"negative offset", data, []int32{-1, 1}, nil, 1},
		{"decreasing offsets", data, []int32{0, 4, 3, 6}, nil, 3},
		{"validity bitmap too small", data, good, []byte{0}, 9},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			_, err := varcol.New(tc.data, tc.offsets, tc.validity, tc.rows,
				func([]byte, []int32, []byte) { called = true })
			if !errors.Is(err, varcol.ErrInvalidInput) {
				t.Fatalf("err = %v, want ErrInvalidInput", err)
			}
			if called {
				t.Fatal("recycler must not run when construction fails")
			}
		})
	}
}

func TestEmptyColumnAndNilValidity(t *testing.T) {
	col, err := varcol.New(nil, []int32{0}, nil, 0, nil)
	if err != nil {
		t.Fatalf("New empty column: %v", err)
	}
	if n, err := col.Len(); err != nil || n != 0 {
		t.Fatalf("Len = (%d, %v), want (0, nil)", n, err)
	}
	if _, _, err := col.Get(0); !errors.Is(err, varcol.ErrInvalidInput) {
		t.Fatalf("Get on empty column err = %v, want ErrInvalidInput", err)
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}

	all, err := varcol.New([]byte("ab"), []int32{0, 1, 2}, nil, 2, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if null, err := all.IsNull(0); err != nil || null {
		t.Fatalf("IsNull(0) = (%v, %v), want (false, nil)", null, err)
	}
	if err := all.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
}

func TestNullRowWithNonEmptyPhysicalRange(t *testing.T) {
	data := []byte("abcWXYZyz")
	offsets := []int32{0, 3, 7, 9}
	validity := setNull(nil, 1)

	col, err := varcol.New(data, offsets, validity, 3, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if null, err := col.IsNull(1); err != nil || !null {
		t.Fatalf("IsNull(1) = (%v, %v), want (true, nil)", null, err)
	}
	v, isNull, err := col.Get(1)
	if err != nil || !isNull || v != nil {
		t.Fatalf("Get(1) = (%q, %v, %v), want (nil, true, nil)", v, isNull, err)
	}

	v, isNull, err = col.Get(0)
	if err != nil || isNull || string(v) != "abc" {
		t.Fatalf("Get(0) = (%q, %v, %v), want (abc, false, nil)", v, isNull, err)
	}

	v[0] = 'Z'
	again, _, err := col.Get(0)
	if err != nil {
		t.Fatalf("Get again: %v", err)
	}
	if string(again) != "abc" {
		t.Fatalf("shared backing mutated through Get result: got %q", again)
	}

	buf, isNull, err := col.AppendValue([]byte("pre:"), 1)
	if err != nil || !isNull || string(buf) != "pre:" {
		t.Fatalf("AppendValue on null = (%q, %v, %v)", buf, isNull, err)
	}
	var sink bytes.Buffer
	n, err := col.WriteValueTo(&sink, 1)
	if err != nil || n != 0 || sink.Len() != 0 {
		t.Fatalf("WriteValueTo on null = (%d, %v), want zero bytes", n, err)
	}

	n, err = col.WriteValueTo(&sink, 2)
	if err != nil || n != 2 || sink.String() != "yz" {
		t.Fatalf("WriteValueTo row2 = (%d, %v, %q)", n, err, sink.String())
	}

	if err := col.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
}

func TestOverlappingSlices(t *testing.T) {
	data := []byte("abcdefgh")
	offsets := []int32{0, 1, 3, 5, 8}
	col, err := varcol.New(data, offsets, nil, 4, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	first, err := col.Slice(0, 3)
	if err != nil {
		t.Fatalf("Slice first: %v", err)
	}
	second, err := col.Slice(2, 4)
	if err != nil {
		t.Fatalf("Slice second: %v", err)
	}

	if n, _ := first.Len(); n != 3 {
		t.Fatalf("first Len = %d, want 3", n)
	}
	if n, _ := second.Len(); n != 2 {
		t.Fatalf("second Len = %d, want 2", n)
	}

	v1, _, err := first.Get(2)
	if err != nil {
		t.Fatalf("first.Get(2): %v", err)
	}
	v2, _, err := second.Get(0)
	if err != nil {
		t.Fatalf("second.Get(0): %v", err)
	}
	if string(v1) != "de" || string(v2) != "de" {
		t.Fatalf("overlapping row reads = %q, %q, want de/de", v1, v2)
	}

	sub, err := second.Slice(1, 2)
	if err != nil {
		t.Fatalf("nested Slice: %v", err)
	}
	v3, _, err := sub.Get(0)
	if err != nil || string(v3) != "fgh" {
		t.Fatalf("nested slice read = (%q, %v), want fgh", v3, err)
	}

	for _, bad := range [][2]int{{-1, 1}, {1, 0}, {0, 5}, {2, 1}} {
		if _, err := col.Slice(bad[0], bad[1]); !errors.Is(err, varcol.ErrInvalidInput) {
			t.Fatalf("Slice(%d,%d) err = %v, want ErrInvalidInput", bad[0], bad[1], err)
		}
	}

	if err := sub.Release(); err != nil {
		t.Fatalf("Release sub: %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("Release first: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("Release second: %v", err)
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release col: %v", err)
	}
}

func TestConcatCompactValidRows(t *testing.T) {
	dataA := []byte("aaXXXbb")
	offA := []int32{0, 2, 5, 7}
	valA := setNull(nil, 1)
	colA, err := varcol.New(dataA, offA, valA, 3, nil)
	if err != nil {
		t.Fatalf("New A: %v", err)
	}

	dataB := []byte("cccc")
	offB := []int32{0, 0, 4}
	valB := setNull(nil, 0)
	colB, err := varcol.New(dataB, offB, valB, 2, nil)
	if err != nil {
		t.Fatalf("New B: %v", err)
	}

	merged, err := varcol.Concat([]*varcol.Column{colA, colB}, nil)
	if err != nil {
		t.Fatalf("Concat: %v", err)
	}

	if n, _ := merged.Len(); n != 5 {
		t.Fatalf("merged Len = %d, want 5", n)
	}
	wantNull := []bool{false, true, false, true, false}
	for i, want := range wantNull {
		got, err := merged.IsNull(i)
		if err != nil {
			t.Fatalf("IsNull(%d): %v", i, err)
		}
		if got != want {
			t.Fatalf("IsNull(%d) = %v, want %v", i, got, want)
		}
	}

	wantValues := []string{"aa", "", "bb", "", "cccc"}
	for i, want := range wantValues {
		v, isNull, err := merged.Get(i)
		if err != nil {
			t.Fatalf("Get(%d): %v", i, err)
		}
		if isNull != wantNull[i] || (!isNull && string(v) != want) {
			t.Fatalf("Get(%d) = (%q, %v), want %q null=%v", i, v, isNull, want, wantNull[i])
		}
	}

	var all bytes.Buffer
	for i := 0; i < 5; i++ {
		if _, err := merged.WriteValueTo(&all, i); err != nil {
			t.Fatalf("WriteValueTo(%d): %v", i, err)
		}
	}
	if all.String() != "aabbcccc" {
		t.Fatalf("compact payload = %q, want aabbcccc", all.String())
	}

	if _, err := varcol.Concat(nil, nil); !errors.Is(err, varcol.ErrInvalidInput) {
		t.Fatalf("Concat(nil) err = %v, want ErrInvalidInput", err)
	}
	if _, err := varcol.Concat([]*varcol.Column{nil}, nil); !errors.Is(err, varcol.ErrInvalidInput) {
		t.Fatalf("Concat with nil column err = %v, want ErrInvalidInput", err)
	}

	if err := merged.Release(); err != nil {
		t.Fatalf("Release merged: %v", err)
	}
	if err := colA.Release(); err != nil {
		t.Fatalf("Release A: %v", err)
	}
	if err := colB.Release(); err != nil {
		t.Fatalf("Release B: %v", err)
	}
}

func TestConcurrentReleaseRecyclesOnce(t *testing.T) {
	const holders = 64
	data := []byte("abcdef")
	offsets := []int32{0, 1, 3, 6}

	var recycleCalls atomic.Int32
	root, err := varcol.New(data, offsets, nil, 3,
		func([]byte, []int32, []byte) { recycleCalls.Add(1) })
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	cols := make([]*varcol.Column, 0, holders)
	cols = append(cols, root)
	for i := 1; i < holders; i++ {
		s, err := root.Slice(0, 3)
		if err != nil {
			t.Fatalf("Slice %d: %v", i, err)
		}
		cols = append(cols, s)
	}

	var wg sync.WaitGroup
	for _, col := range cols {
		wg.Add(1)
		go func(c *varcol.Column) {
			defer wg.Done()
			if err := c.Release(); err != nil {
				t.Errorf("Release: %v", err)
			}
		}(col)
	}
	wg.Wait()

	if got := recycleCalls.Load(); got != 1 {
		t.Fatalf("recycler called %d times, want exactly 1", got)
	}

	if err := root.Release(); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("double Release err = %v, want ErrClosed", err)
	}
}

func TestAccessAfterRelease(t *testing.T) {
	col, err := varcol.New([]byte("ab"), []int32{0, 1, 2}, nil, 2, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s, err := col.Slice(0, 1)
	if err != nil {
		t.Fatalf("Slice: %v", err)
	}
	if err := s.Release(); err != nil {
		t.Fatalf("Release slice: %v", err)
	}

	if _, err := s.Len(); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("Len after release err = %v, want ErrClosed", err)
	}
	if _, _, err := s.Get(0); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("Get after release err = %v, want ErrClosed", err)
	}
	if _, err := s.IsNull(0); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("IsNull after release err = %v, want ErrClosed", err)
	}
	if _, _, err := s.AppendValue(nil, 0); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("AppendValue after release err = %v, want ErrClosed", err)
	}
	if _, err := s.WriteValueTo(&bytes.Buffer{}, 0); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("WriteValueTo after release err = %v, want ErrClosed", err)
	}
	if _, err := s.Slice(0, 1); !errors.Is(err, varcol.ErrClosed) {
		t.Fatalf("Slice after release err = %v, want ErrClosed", err)
	}

	// 一个持有者释放不影响其他持有者。
	if n, err := col.Len(); err != nil || n != 2 {
		t.Fatalf("root Len after slice release = (%d, %v), want (2, nil)", n, err)
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release root: %v", err)
	}
}

func TestConcatRejectsReleasedInput(t *testing.T) {
	col, err := varcol.New([]byte("ab"), []int32{0, 1, 2}, nil, 2, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := col.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, err := varcol.Concat([]*varcol.Column{col}, nil); !errors.Is(err, varcol.ErrInvalidInput) {
		t.Fatalf("Concat with released column err = %v, want ErrInvalidInput", err)
	}
}
