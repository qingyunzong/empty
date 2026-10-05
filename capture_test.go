package executor

import (
	"bytes"
	"testing"
)

func TestCaptureWithinBudgetKeepsEverything(t *testing.T) {
	c := NewCapture(100)
	data := []byte("hello world")
	if _, err := c.Write(data); err != nil {
		t.Fatal(err)
	}
	if got := append(c.Prefix(), c.Tail()...); !bytes.Equal(got, data) {
		t.Fatalf("prefix+tail = %q, want %q", got, data)
	}
	st := c.Stats()
	if st.Total != 11 || st.Retained != 11 || st.Dropped != 0 {
		t.Fatalf("stats = %+v", st)
	}
	if c.Truncated() {
		t.Fatal("should not be truncated")
	}
}

func TestCaptureDropsMiddle(t *testing.T) {
	c := NewCapture(10) // prefix 5, tail 5
	data := []byte("0123456789abcdefghij")
	c.Write(data)
	if got := c.Prefix(); !bytes.Equal(got, []byte("01234")) {
		t.Fatalf("prefix = %q", got)
	}
	if got := c.Tail(); !bytes.Equal(got, []byte("fghij")) {
		t.Fatalf("tail = %q", got)
	}
	st := c.Stats()
	if st.Total != 20 || st.Retained != 10 || st.Dropped != 10 {
		t.Fatalf("stats = %+v", st)
	}
	if !c.Truncated() {
		t.Fatal("should be truncated")
	}
}

func TestCaptureTailRingAcrossWrites(t *testing.T) {
	c := NewCapture(6) // prefix 3, tail 3
	// Feed byte by byte to exercise ring wraparound.
	for _, b := range []byte("0123456789") {
		c.Write([]byte{b})
	}
	if got := c.Prefix(); !bytes.Equal(got, []byte("012")) {
		t.Fatalf("prefix = %q", got)
	}
	if got := c.Tail(); !bytes.Equal(got, []byte("789")) {
		t.Fatalf("tail = %q", got)
	}
	if st := c.Stats(); st.Dropped != 4 {
		t.Fatalf("dropped = %d, want 4", st.Dropped)
	}
}

func TestCaptureLargeSingleWrite(t *testing.T) {
	c := NewCapture(8) // prefix 4, tail 4
	data := make([]byte, 1<<20)
	for i := range data {
		data[i] = byte(i)
	}
	c.Write(data)
	if got := c.Prefix(); !bytes.Equal(got, data[:4]) {
		t.Fatalf("prefix mismatch")
	}
	if got := c.Tail(); !bytes.Equal(got, data[len(data)-4:]) {
		t.Fatalf("tail mismatch")
	}
	if st := c.Stats(); st.Total != int64(len(data)) || st.Dropped != int64(len(data)-8) {
		t.Fatalf("stats = %+v", st)
	}
}

func TestCaptureZeroAndTinyBudgets(t *testing.T) {
	c0 := NewCapture(0)
	c0.Write([]byte("abc"))
	if st := c0.Stats(); st.Total != 3 || st.Retained != 0 || st.Dropped != 3 {
		t.Fatalf("zero budget stats = %+v", st)
	}

	c1 := NewCapture(1) // prefix 0, tail 1
	c1.Write([]byte("abc"))
	if got := c1.Tail(); !bytes.Equal(got, []byte("c")) {
		t.Fatalf("tail = %q", got)
	}
	if st := c1.Stats(); st.Retained != 1 || st.Dropped != 2 {
		t.Fatalf("tiny budget stats = %+v", st)
	}
}
