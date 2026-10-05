package telemetry

import (
	"bytes"
	"testing"
)

// buildPatternStream writes a mixed pattern of fields and returns the
// writer.
func buildPatternStream(order BitOrder) *Writer {
	w := NewWriter(order)
	for i := 1; i <= 17; i++ {
		w.WriteBits(uint64(0x5a5a*i)&(uint64(1)<<uint(i)-1), i)
	}
	w.WriteVarint(300)
	w.WriteVarintSigned(-12345)
	w.Align(8)
	w.WriteSigned(-99, 13)
	w.WriteBits(0xAB, 8)
	return w
}

// TestPauseResumeEveryBit pauses at every single bit position, serializes
// the reader, restores it into a fresh reader, and checks the remaining
// bits match an uninterrupted read.
func TestPauseResumeEveryBit(t *testing.T) {
	for _, o := range orders {
		w := buildPatternStream(o.order)
		data := w.Bytes()
		total := w.Pos()

		want := make([]uint64, total)
		ref := NewReaderBits(data, total, o.order)
		for i := 0; i < total; i++ {
			b, err := ref.ReadBit()
			if err != nil {
				t.Fatalf("%s: reference read: %v", o.name, err)
			}
			want[i] = b
		}

		for pause := 0; pause <= total; pause++ {
			r := NewReaderBits(data, total, o.order)
			got := make([]uint64, 0, total)
			for i := 0; i < pause; i++ {
				b, err := r.ReadBit()
				if err != nil {
					t.Fatalf("%s pause=%d: pre-read: %v", o.name, pause, err)
				}
				got = append(got, b)
			}
			snap := r.Snapshot()
			r2, err := RestoreReader(snap, nil)
			if err != nil {
				t.Fatalf("%s pause=%d: restore: %v", o.name, pause, err)
			}
			if r2.Pos() != pause {
				t.Fatalf("%s pause=%d: restored pos=%d", o.name, pause, r2.Pos())
			}
			for i := pause; i < total; i++ {
				b, err := r2.ReadBit()
				if err != nil {
					t.Fatalf("%s pause=%d: post-read: %v", o.name, pause, err)
				}
				got = append(got, b)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("%s pause=%d: bit %d = %d, want %d", o.name, pause, i, got[i], want[i])
				}
			}
		}
	}
}

// TestSnapshotSurvivesSerialization checks the snapshot is plain bytes:
// a restored reader continues a structured decode mid-stream.
func TestSnapshotSurvivesSerialization(t *testing.T) {
	for _, o := range orders {
		w := buildPatternStream(o.order)
		r := NewReaderBits(w.Bytes(), w.Pos(), o.order)
		if _, err := r.ReadBits(7); err != nil {
			t.Fatal(err)
		}
		snap := r.Snapshot()
		// Corrupt magic must be rejected.
		bad := bytes.Clone(snap)
		bad[0] ^= 0xff
		if _, err := RestoreReader(bad, nil); err == nil {
			t.Fatalf("%s: corrupted snapshot accepted", o.name)
		}
		r2, err := RestoreReader(snap, nil)
		if err != nil {
			t.Fatalf("%s: %v", o.name, err)
		}
		rest, err := r2.ReadBits(10)
		if err != nil {
			t.Fatalf("%s: %v", o.name, err)
		}
		r3 := NewReaderBits(w.Bytes(), w.Pos(), o.order)
		r3.Seek(7)
		want, _ := r3.ReadBits(10)
		if rest != want {
			t.Fatalf("%s: resumed read %#x, want %#x", o.name, rest, want)
		}
	}
}

// TestSnapshotTruncated checks malformed snapshots are rejected.
func TestSnapshotTruncated(t *testing.T) {
	w := buildPatternStream(MSBFirst)
	r := NewReaderBits(w.Bytes(), w.Pos(), MSBFirst)
	snap := r.Snapshot()
	for _, n := range []int{0, 3, 5, 12, 28, len(snap) - 1} {
		if _, err := RestoreReader(snap[:n], nil); err == nil {
			t.Fatalf("truncated snapshot of %d bytes accepted", n)
		}
	}
}

// TestWriterSnapshotRollback snapshots a writer, continues two divergent
// continuations, and checks both decode correctly from the shared prefix.
func TestWriterSnapshotRollback(t *testing.T) {
	for _, o := range orders {
		w := NewWriter(o.order)
		w.WriteBits(0x15, 5)
		snap := w.Snapshot()

		w.WriteBits(0x2, 3) // continuation A
		bitsA := w.Bytes()
		posA := w.Pos()

		w2, err := RestoreWriter(snap)
		if err != nil {
			t.Fatalf("%s: %v", o.name, err)
		}
		w2.WriteBits(0x5, 3) // continuation B
		bitsB := w2.Bytes()

		rA := NewReaderBits(bitsA, posA, o.order)
		if v, _ := rA.ReadBits(5); v != 0x15 {
			t.Fatalf("%s: A prefix %#x", o.name, v)
		}
		if v, _ := rA.ReadBits(3); v != 0x2 {
			t.Fatalf("%s: A tail %#x", o.name, v)
		}
		rB := NewReaderBits(bitsB, w2.Pos(), o.order)
		if v, _ := rB.ReadBits(5); v != 0x15 {
			t.Fatalf("%s: B prefix %#x", o.name, v)
		}
		if v, _ := rB.ReadBits(3); v != 0x5 {
			t.Fatalf("%s: B tail %#x", o.name, v)
		}
	}
}
