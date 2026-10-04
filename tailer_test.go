package tailer

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func newWriter(t *testing.T, dir string) *Writer {
	t.Helper()
	w, err := NewWriter(dir)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	t.Cleanup(func() { w.Close() })
	return w
}

func newReader(t *testing.T, dir string) *Reader {
	t.Helper()
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

func mustWait(t *testing.T, r *Reader) (int, int64) {
	t.Helper()
	segBefore, offBefore := r.Position()
	rec, st, err := r.Next()
	if err != nil || st != StatusWait {
		t.Fatalf("want Wait, got %v (rec=%+v err=%v)", st, rec, err)
	}
	segAfter, offAfter := r.Position()
	if segBefore != segAfter || offBefore != offAfter {
		t.Fatalf("cursor moved on Wait: (%d,%d) -> (%d,%d)", segBefore, offBefore, segAfter, offAfter)
	}
	return segAfter, offAfter
}

func mustRecord(t *testing.T, r *Reader, wantPayload string, wantSeg int) Record {
	t.Helper()
	rec, st, err := r.Next()
	if err != nil || st != StatusRecord {
		t.Fatalf("want Record, got %v (err=%v)", st, err)
	}
	if string(rec.Payload) != wantPayload {
		t.Fatalf("payload = %q, want %q", rec.Payload, wantPayload)
	}
	if rec.Segment != wantSeg {
		t.Fatalf("segment = %d, want %d", rec.Segment, wantSeg)
	}
	return rec
}

func mustFail(t *testing.T, r *Reader) {
	t.Helper()
	_, st, err := r.Next()
	if st != StatusFail || err == nil {
		t.Fatalf("want Fail with error, got %v (err=%v)", st, err)
	}
}

// TestIncompleteTailWaits splits a record's header and payload across many
// writes; every intermediate read must report Wait and keep the cursor.
func TestIncompleteTailWaits(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	// Empty directory read waits without a cursor.
	mustWait(t, r)

	enc := EncodeRecord([]byte("hello-tail"))
	// Feed the encoding byte by byte; only the final byte completes it.
	for i := 0; i < len(enc); i++ {
		if err := w.AppendRaw(enc[i : i+1]); err != nil {
			t.Fatal(err)
		}
		if i < len(enc)-1 {
			seg, off := mustWait(t, r)
			if seg != 1 || off != 0 {
				t.Fatalf("cursor = (%d,%d), want (1,0)", seg, off)
			}
		}
	}
	rec := mustRecord(t, r, "hello-tail", 1)
	if rec.Offset != 0 {
		t.Fatalf("offset = %d, want 0", rec.Offset)
	}
	// Cursor advanced past exactly one record.
	if seg, off := r.Position(); seg != 1 || off != int64(len(enc)) {
		t.Fatalf("cursor = (%d,%d), want (1,%d)", seg, off, len(enc))
	}
	// Nothing more: waits at the same cursor.
	mustWait(t, r)
}

// TestSplitHeaderAndBody writes the header in two parts and the payload in
// two parts, checking Wait at each boundary.
func TestSplitHeaderAndBody(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	enc := EncodeRecord([]byte("split-me"))
	cuts := []int{3, headerLen, headerLen + 4, len(enc)}
	prev := 0
	for _, c := range cuts[:len(cuts)-1] {
		if err := w.AppendRaw(enc[prev:c]); err != nil {
			t.Fatal(err)
		}
		mustWait(t, r)
		prev = c
	}
	if err := w.AppendRaw(enc[prev:]); err != nil {
		t.Fatal(err)
	}
	mustRecord(t, r, "split-me", 1)
}

// TestCorruptMiddleFails: valid records before and after, corrupt bytes in
// the middle must surface as Fail while earlier records still read fine.
func TestCorruptMiddleFails(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	if err := w.Append([]byte("good-1")); err != nil {
		t.Fatal(err)
	}
	// Corrupt record: valid magic, but payload CRC does not match.
	bad := EncodeRecord([]byte("evil"))
	bad[len(bad)-1] ^= 0xFF
	if err := w.AppendRaw(bad); err != nil {
		t.Fatal(err)
	}

	mustRecord(t, r, "good-1", 1)
	mustFail(t, r)
}

// TestBadMagicFails covers corruption in the header itself.
func TestBadMagicFails(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	if err := w.AppendRaw([]byte{0xDE, 0xAD, 0, 0, 0, 0, 0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	mustFail(t, r)
}

// TestRotationOldHandleDrainsFirst rotates while the reader is mid-segment:
// the reader must finish the old segment before switching, and attribute
// every record to the segment it was written to.
func TestRotationOldHandleDrainsFirst(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	for _, s := range []string{"a1", "a2", "a3"} {
		if err := w.Append([]byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	// Reader consumes only the first record, then the writer rotates and
	// appends to the new segment.
	mustRecord(t, r, "a1", 1)
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"b1", "b2"} {
		if err := w.Append([]byte(s)); err != nil {
			t.Fatal(err)
		}
	}

	// Old handle drains first...
	mustRecord(t, r, "a2", 1)
	mustRecord(t, r, "a3", 1)
	// ...then the reader switches to the new segment by itself.
	mustRecord(t, r, "b1", 2)
	mustRecord(t, r, "b2", 2)
	if seg, _ := r.Position(); seg != 2 {
		t.Fatalf("reader segment = %d, want 2", seg)
	}
	// Tail of the newest segment waits.
	mustWait(t, r)
}

// TestTornRecordOnRotationFails: a partial record abandoned by rotation is
// unrecoverable and must fail rather than wait forever.
func TestTornRecordOnRotationFails(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	enc := EncodeRecord([]byte("never-finished"))
	if err := w.AppendRaw(enc[:5]); err != nil { // partial header
		t.Fatal(err)
	}
	mustWait(t, r) // incomplete tail, no newer segment yet
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}
	if err := w.Append([]byte("next-seg")); err != nil {
		t.Fatal(err)
	}
	mustFail(t, r) // torn record in old segment
}

// TestNoDupNoLossAcrossSegments writes many records with randomized
// fragmentation and rotations, then verifies the read stream matches the
// written sequence exactly (no duplicates, no losses) with correct segment
// attribution.
func TestNoDupNoLossAcrossSegments(t *testing.T) {
	dir := t.TempDir()
	w := newWriter(t, dir)
	r := newReader(t, dir)

	rng := rand.New(rand.NewSource(42))
	type want struct {
		payload string
		segment int
	}
	var written, got []want

	// drain reads every complete record currently available.
	drain := func() {
		t.Helper()
		for {
			rec, st, err := r.Next()
			if err != nil {
				t.Fatalf("Next: %v", err)
			}
			if st == StatusWait {
				return
			}
			if st != StatusRecord {
				t.Fatalf("unexpected status %v", st)
			}
			got = append(got, want{string(rec.Payload), rec.Segment})
		}
	}

	// Interleave fragmented writes with reads to stress the Wait path.
	for i := 0; i < 200; i++ {
		drain() // catch up so the reader sits exactly at the write tail
		payload := fmt.Sprintf("rec-%04d-%d", i, rng.Intn(1000))
		enc := EncodeRecord([]byte(payload))
		seg := w.Segment()
		// Split the encoded record into 1-5 random fragments.
		pos := 0
		for pos < len(enc) {
			n := 1 + rng.Intn(len(enc)-pos)
			if err := w.AppendRaw(enc[pos : pos+n]); err != nil {
				t.Fatal(err)
			}
			pos += n
			if pos < len(enc) {
				mustWait(t, r) // mid-record: must wait, cursor kept
			}
		}
		written = append(written, want{payload, seg})
		// Rotate roughly every 25 records.
		if i%25 == 24 {
			if err := w.Rotate(); err != nil {
				t.Fatal(err)
			}
		}
	}

	// Drain everything and compare exactly.
	drain()
	if len(got) != len(written) {
		t.Fatalf("read %d records, wrote %d (loss or duplication)", len(got), len(written))
	}
	for i := range written {
		if got[i] != written[i] {
			t.Fatalf("record %d = %+v, want %+v", i, got[i], written[i])
		}
	}
	// Final cursor sits at the end of the last segment.
	seg, off := r.Position()
	fi, err := os.Stat(filepath.Join(dir, segmentName(seg)))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != off {
		t.Fatalf("final cursor offset %d, segment %d size %d", off, seg, fi.Size())
	}
}

// TestWaitBeforeAnySegment: a reader opened on an empty directory waits,
// then picks up the first segment once it appears.
func TestWaitBeforeAnySegment(t *testing.T) {
	dir := t.TempDir()
	r := newReader(t, dir)
	mustWait(t, r)

	w := newWriter(t, dir)
	if err := w.Append([]byte("first")); err != nil {
		t.Fatal(err)
	}
	mustRecord(t, r, "first", 1)
}
