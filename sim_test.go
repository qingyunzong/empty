package srx

import (
	"bytes"
	"fmt"
	"slices"
	"testing"
)

func buildSim(t *testing.T, m, w, retries, timeout, latency, nFrames int, dropFrame, dropAck LossFunc) *Sim {
	t.Helper()
	sd, err := NewSender(m, w, retries, timeout)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := NewReceiver(m, w)
	if err != nil {
		t.Fatal(err)
	}
	var data [][]byte
	for i := 0; i < nFrames; i++ {
		data = append(data, []byte{byte(i)})
	}
	return NewSim(latency, sd, rc, dropFrame, dropAck, data)
}

func wantData(n int) [][]byte {
	var out [][]byte
	for i := 0; i < n; i++ {
		out = append(out, []byte{byte(i)})
	}
	return out
}

func equalData(a, b [][]byte) bool {
	return slices.EqualFunc(a, b, bytes.Equal)
}

func maskDrops(mask uint64, k int) LossFunc {
	return func(n int) bool { return n < k && mask&(1<<uint(n)) != 0 }
}

// A lost frame is retransmitted while its selectively acknowledged
// neighbours are never sent twice.
func TestRetransmitsOnlyUnacked(t *testing.T) {
	dropFirstFrame1 := func(n int) bool { return n == 1 } // first tx of seq 1
	sim := buildSim(t, 8, 3, 5, 10, 2, 5, dropFirstFrame1, nil)
	sim.Run()

	if got := sim.Receiver.Delivered; !equalData(got, wantData(5)) {
		t.Fatalf("delivered %v, want 5 frames in order", got)
	}
	var retries []SendRecord
	for _, r := range sim.Sender.Log {
		if r.Attempt > 0 {
			retries = append(retries, r)
		}
	}
	if len(retries) != 1 || retries[0].Seq != 1 || retries[0].Attempt != 1 {
		t.Fatalf("retransmissions = %v, want exactly one retry of seq 1", retries)
	}
}

// An acknowledgement arriving at the exact deadline instant suppresses the
// retransmission: acknowledgements are processed before timeouts.
func TestAckBeatsTimeoutAtSameInstant(t *testing.T) {
	// timeout 6, latency 3: ack of a frame sent at t=0 arrives at t=6,
	// exactly when its retransmission deadline fires.
	sim := buildSim(t, 8, 3, 3, 6, 3, 3, nil, nil)
	sim.Run()

	if got := sim.Receiver.Delivered; !equalData(got, wantData(3)) {
		t.Fatalf("delivered %v, want 3 frames", got)
	}
	for _, r := range sim.Sender.Log {
		if r.Attempt > 0 {
			t.Fatalf("frame %d retransmitted despite same-instant ack: %+v", r.Seq, r)
		}
	}
	if len(sim.Sender.Log) != 3 {
		t.Fatalf("log = %v, want exactly 3 first transmissions", sim.Sender.Log)
	}
}

// Retransmissions count toward the limit: with MaxRetries = 2 each frame is
// sent at most 1+2 times, then marked failed and never sent again.
func TestRetryLimit(t *testing.T) {
	dropAll := func(n int) bool { return true }
	sim := buildSim(t, 8, 3, 2, 5, 1, 3, dropAll, nil)
	sim.Run()

	perSeq := map[int][]int{}
	for _, r := range sim.Sender.Log {
		perSeq[r.Seq] = append(perSeq[r.Seq], r.Attempt)
	}
	for seq := 0; seq < 3; seq++ {
		if !slices.Equal(perSeq[seq], []int{0, 1, 2}) {
			t.Errorf("seq %d attempts = %v, want [0 1 2]", seq, perSeq[seq])
		}
	}
	if sim.Sender.InFlight() != 0 {
		t.Errorf("failed frames must be slid past, in-flight = %d", sim.Sender.InFlight())
	}
	if len(sim.Receiver.Delivered) != 0 {
		t.Errorf("nothing may be delivered, got %v", sim.Receiver.Delivered)
	}
}

// Enumerate every loss trajectory over the first k frame transmissions,
// the first k ack transmissions, and pairwise combinations: the receiver
// must always deliver the complete stream exactly once and in order.
func TestLossTrajectoryEnumeration(t *testing.T) {
	const (
		m, w    = 8, 3
		retries = 8
		timeout = 8
		latency = 2
		nFrames = 6
		k       = 9
		k2      = 6
	)
	want := wantData(nFrames)

	check := func(df, da LossFunc, ctx string) {
		t.Helper()
		sim := buildSim(t, m, w, retries, timeout, latency, nFrames, df, da)
		sim.Run()
		got := sim.Receiver.Delivered
		if !equalData(got, want) {
			t.Fatalf("%s: delivered %v, want each of %v exactly once in order", ctx, got, want)
		}
	}

	for mask := 0; mask < 1<<k; mask++ {
		check(maskDrops(uint64(mask), k), nil, fmt.Sprintf("frame-loss mask %09b", mask))
	}
	for mask := 0; mask < 1<<k; mask++ {
		check(nil, maskDrops(uint64(mask), k), fmt.Sprintf("ack-loss mask %09b", mask))
	}
	for fm := 0; fm < 1<<k2; fm++ {
		for am := 0; am < 1<<k2; am++ {
			check(maskDrops(uint64(fm), k2), maskDrops(uint64(am), k2),
				fmt.Sprintf("frame/ack masks %06b/%06b", fm, am))
		}
	}
}

// Sequence numbers wrap several times around the modulus while delivery
// stays unique and ordered.
func TestWrapAroundDelivery(t *testing.T) {
	const n = 25
	sim := buildSim(t, 8, 3, 4, 6, 2, n, nil, nil)
	sim.Run()
	if got := sim.Receiver.Delivered; !equalData(got, wantData(n)) {
		t.Fatalf("delivered %v, want %d frames in order", got, n)
	}
	for _, r := range sim.Sender.Log {
		if r.Wire != r.Seq%8 {
			t.Fatalf("record %+v: wire seq must be absolute seq mod 8", r)
		}
	}
}

// The window may shrink while frames are unacknowledged; in-flight frames
// keep their deadlines and retry counts, and new sends respect the smaller
// window.
func TestWindowShrinkKeepsInFlight(t *testing.T) {
	sim := buildSim(t, 16, 6, 5, 10, 2, 8, nil, nil)
	if got := sim.Sender.InFlight(); got != 6 {
		t.Fatalf("in-flight = %d, want 6", got)
	}
	if err := sim.SetWindow(3); err != nil {
		t.Fatal(err)
	}
	for seq := 0; seq < 6; seq++ {
		f := sim.Sender.frames[seq]
		if f == nil {
			t.Fatalf("shrink dropped in-flight frame %d", seq)
		}
		if f.Deadline != 10 || f.Retries != 0 {
			t.Errorf("frame %d mutated by shrink: %+v", seq, f)
		}
	}
	for sim.Step() {
		if sim.Sender.next > 6 && sim.Sender.InFlight() > 3 {
			t.Fatalf("t=%d: sent beyond shrunk window, in-flight = %d", sim.Time, sim.Sender.InFlight())
		}
	}
	if got := sim.Receiver.Delivered; !equalData(got, wantData(8)) {
		t.Fatalf("delivered %v, want 8 frames in order", got)
	}
	if err := sim.SetWindow(8); err == nil {
		t.Error("window 8 with modulus 16 must be rejected")
	}
}

// A snapshot preserves every frame's deadline and retransmission count.
func TestSnapshotPreservesFrameState(t *testing.T) {
	dropSome := func(n int) bool { return n == 0 || n == 3 }
	sim := buildSim(t, 8, 3, 4, 7, 2, 6, dropSome, nil)
	for i := 0; i < 12; i++ {
		sim.Step()
	}
	snap := sim.Clone()
	if len(snap.Sender.frames) == 0 {
		t.Fatal("expected in-flight frames at snapshot time")
	}
	for seq, f := range sim.Sender.frames {
		g := snap.Sender.frames[seq]
		if g == nil {
			t.Fatalf("frame %d missing from snapshot", seq)
		}
		if g.Deadline != f.Deadline || g.Retries != f.Retries || g.Acked != f.Acked || g.Failed != f.Failed {
			t.Errorf("frame %d: snapshot %+v, original %+v", seq, g, f)
		}
	}
}

// Pause and resume at every single event boundary: the restored simulation
// must replay the identical send trajectory, and the original must be
// unaffected by the clone.
func TestSnapshotRestoreSameTrajectory(t *testing.T) {
	const (
		m, w    = 8, 3
		retries = 4
		timeout = 7
		latency = 2
		nFrames = 6
	)
	dropFrame := func(n int) bool { return n == 2 || n == 5 }
	dropAck := func(n int) bool { return n == 1 }

	baseline := buildSim(t, m, w, retries, timeout, latency, nFrames, dropFrame, dropAck)
	baseline.Run()
	wantLog := baseline.Sender.Log
	wantDelivered := baseline.Receiver.Delivered

	steps := 0
	for counter := buildSim(t, m, w, retries, timeout, latency, nFrames, dropFrame, dropAck); counter.Step(); steps++ {
	}

	for i := 0; i <= steps; i++ {
		sim := buildSim(t, m, w, retries, timeout, latency, nFrames, dropFrame, dropAck)
		for j := 0; j < i; j++ {
			sim.Step()
		}
		snap := sim.Clone()
		snap.Run()
		if !slices.Equal(snap.Sender.Log, wantLog) {
			t.Fatalf("resume at event %d/%d: trajectory diverged\n got %v\nwant %v", i, steps, snap.Sender.Log, wantLog)
		}
		if !equalData(snap.Receiver.Delivered, wantDelivered) {
			t.Fatalf("resume at event %d/%d: delivered %v, want %v", i, steps, snap.Receiver.Delivered, wantDelivered)
		}
		sim.Run()
		if !slices.Equal(sim.Sender.Log, wantLog) {
			t.Fatalf("original affected by clone at event %d/%d", i, steps)
		}
	}
}
