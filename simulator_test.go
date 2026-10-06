package simulator

import (
	"fmt"
	"reflect"
	"testing"
)

func payloads(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("msg-%d", i)
	}
	return out
}

func mustNew(t *testing.T, cfg Config) *Sim {
	t.Helper()
	s, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func attemptsFor(traj []Transmission, abs int) []int {
	var out []int
	for _, tr := range traj {
		if tr.Abs == abs {
			out = append(out, tr.Attempt)
		}
	}
	return out
}

// Selective and cumulative ack modes both deliver every payload exactly once,
// in order, with a single transmission per frame when nothing is lost.
func TestBasicDeliveryBothAckModes(t *testing.T) {
	for _, cumulative := range []bool{false, true} {
		t.Run(fmt.Sprintf("cumulative=%v", cumulative), func(t *testing.T) {
			s := mustNew(t, Config{
				Modulus: 16, Window: 4, Timeout: 10, Latency: 3,
				MaxRetries: 3, Cumulative: cumulative,
			})
			want := payloads(10)
			s.Send(want...)
			s.Run()
			if !s.Complete() {
				t.Fatalf("not complete, inflight=%d", s.Inflight())
			}
			if got := s.Delivered(); !reflect.DeepEqual(got, want) {
				t.Fatalf("delivered %v, want %v", got, want)
			}
			if len(s.Trajectory()) != len(want) {
				t.Fatalf("trajectory len %d, want %d (no retransmits expected)",
					len(s.Trajectory()), len(want))
			}
		})
	}
}

// A cumulative ack covers every in-flight frame up to its sequence number.
func TestCumulativeAckCoversPrefix(t *testing.T) {
	s := mustNew(t, Config{
		Modulus: 16, Window: 4, Timeout: 10, Latency: 3, MaxRetries: 3,
	})
	s.Send(payloads(4)...)
	if s.Inflight() != 4 {
		t.Fatalf("inflight %d, want 4", s.Inflight())
	}
	s.ack(2, true) // frames 0,1,2 have seq 0,1,2
	if s.Inflight() != 1 {
		t.Fatalf("inflight %d after cumulative ack, want 1", s.Inflight())
	}
	if got := s.Frames(); len(got) != 1 || got[0].Abs != 3 {
		t.Fatalf("remaining frames %v, want only abs=3", got)
	}
	// A selective ack only clears its own frame.
	s.ack(3, false)
	if s.Inflight() != 0 {
		t.Fatalf("inflight %d after selective ack, want 0", s.Inflight())
	}
}

// With latency == timeout, the ack and the retransmission timer expire at the
// same tick; the ack is processed first, so nothing is ever retransmitted.
func TestAckBeforeTimeoutAtSameTick(t *testing.T) {
	for _, cumulative := range []bool{false, true} {
		s := mustNew(t, Config{
			Modulus: 8, Window: 3, Timeout: 5, Latency: 5,
			MaxRetries: 3, Cumulative: cumulative,
		})
		want := payloads(9)
		s.Send(want...)
		s.Run()
		if got := s.Delivered(); !reflect.DeepEqual(got, want) {
			t.Fatalf("cumulative=%v: delivered %v, want %v", cumulative, got, want)
		}
		for _, tr := range s.Trajectory() {
			if tr.Attempt != 0 {
				t.Fatalf("cumulative=%v: unexpected retransmission %+v", cumulative, tr)
			}
		}
		if len(s.Failed()) != 0 {
			t.Fatalf("cumulative=%v: unexpected failures %v", cumulative, s.Failed())
		}
	}
}

// Only unacknowledged frames are retransmitted: a lost frame is retried while
// its peers are sent exactly once, and a stale timeout for an already-acked
// frame never triggers a send.
func TestRetransmissionOnlyForUnacked(t *testing.T) {
	s := mustNew(t, Config{
		Modulus: 16, Window: 3, Timeout: 6, Latency: 2, MaxRetries: 3,
		Loss: func(abs, attempt int) bool { return abs == 1 && attempt == 0 },
	})
	want := payloads(6)
	s.Send(want...)
	s.Run()
	if got := s.Delivered(); !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered %v, want %v", got, want)
	}
	traj := s.Trajectory()
	if len(traj) != len(want)+1 {
		t.Fatalf("trajectory len %d, want %d", len(traj), len(want)+1)
	}
	for abs := 0; abs < len(want); abs++ {
		attempts := attemptsFor(traj, abs)
		wantAttempts := []int{0}
		if abs == 1 {
			wantAttempts = []int{0, 1}
		}
		if !reflect.DeepEqual(attempts, wantAttempts) {
			t.Fatalf("frame %d attempts %v, want %v", abs, attempts, wantAttempts)
		}
	}
}

// Retransmissions count toward the retry limit; a frame that exhausts it is
// reported as failed after exactly MaxRetries retransmissions.
func TestRetryLimitCountsRetransmissions(t *testing.T) {
	s := mustNew(t, Config{
		Modulus: 8, Window: 2, Timeout: 4, Latency: 1, MaxRetries: 2,
		Loss: func(abs, attempt int) bool { return true },
	})
	s.Send("doomed")
	s.Run()
	if got := s.Failed(); !reflect.DeepEqual(got, []int{0}) {
		t.Fatalf("failed %v, want [0]", got)
	}
	if got := attemptsFor(s.Trajectory(), 0); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Fatalf("attempts %v, want [0 1 2]", got)
	}
	if got := s.Delivered(); len(got) != 0 {
		t.Fatalf("delivered %v, want none", got)
	}
}

// Sequence numbers wrap around the modulus; with window < modulus/2 the
// receiver still delivers every payload exactly once and in order.
func TestWrapAroundSequenceNumbers(t *testing.T) {
	for _, cumulative := range []bool{false, true} {
		s := mustNew(t, Config{
			Modulus: 8, Window: 3, Timeout: 5, Latency: 2, MaxRetries: 3,
			Cumulative: cumulative,
			Loss:       func(abs, attempt int) bool { return attempt == 0 && abs%5 == 2 },
		})
		want := payloads(40)
		s.Send(want...)
		s.Run()
		if got := s.Delivered(); !reflect.DeepEqual(got, want) {
			t.Fatalf("cumulative=%v: delivered %v, want %v", cumulative, got, want)
		}
		if len(s.Failed()) != 0 {
			t.Fatalf("cumulative=%v: failures %v", cumulative, s.Failed())
		}
		seen := map[int]bool{}
		for _, tr := range s.Trajectory() {
			if tr.Seq != tr.Abs%8 {
				t.Fatalf("transmission %+v has wrong seq", tr)
			}
			seen[tr.Seq] = true
		}
		if len(seen) != 8 {
			t.Fatalf("sequence space not fully exercised: %v", seen)
		}
	}
}

// Enumerate every loss trajectory in which each frame is lost up to
// MaxRetries times; delivery must always be exactly the input, in order.
func TestEnumerateLossTrajectories(t *testing.T) {
	const n = 5
	const maxRetries = 2
	want := payloads(n)
	total := 1
	for i := 0; i < n; i++ {
		total *= maxRetries + 1
	}
	for combo := 0; combo < total; combo++ {
		losses := make([]int, n)
		for i, c := 0, combo; i < n; i, c = i+1, c/(maxRetries+1) {
			losses[i] = c % (maxRetries + 1)
		}
		for _, cumulative := range []bool{false, true} {
			s := mustNew(t, Config{
				Modulus: 16, Window: 4, Timeout: 4, Latency: 1,
				MaxRetries: maxRetries, Cumulative: cumulative,
				Loss: func(abs, attempt int) bool {
					return abs < n && attempt < losses[abs]
				},
			})
			s.Send(want...)
			s.Run()
			if got := s.Delivered(); !reflect.DeepEqual(got, want) {
				t.Fatalf("losses=%v cumulative=%v: delivered %v, want %v",
					losses, cumulative, got, want)
			}
			if len(s.Failed()) != 0 {
				t.Fatalf("losses=%v cumulative=%v: failures %v",
					losses, cumulative, s.Failed())
			}
		}
	}
}

// The window may shrink while frames are in flight: in-flight frames keep
// their deadlines and retry counts, and no new frame is sent until the
// in-flight count drops below the new window.
func TestResizeWindowWithInflight(t *testing.T) {
	s := mustNew(t, Config{
		Modulus: 16, Window: 4, Timeout: 10, Latency: 3, MaxRetries: 3,
	})
	want := payloads(8)
	s.Send(want...)
	if s.Inflight() != 4 {
		t.Fatalf("inflight %d, want 4", s.Inflight())
	}
	before := s.Frames()
	if err := s.ResizeWindow(2); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if s.Inflight() != 4 {
		t.Fatalf("shrink dropped in-flight frames: inflight %d", s.Inflight())
	}
	if got := s.Frames(); !reflect.DeepEqual(got, before) {
		t.Fatalf("shrink altered in-flight frames: %v, want %v", got, before)
	}
	s.sendHook = func(inflight int) {
		if inflight >= 2 {
			t.Fatalf("send attempted with %d in flight under window 2", inflight)
		}
	}
	s.Run()
	if got := s.Delivered(); !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered %v, want %v", got, want)
	}
	if err := s.ResizeWindow(8); err == nil {
		t.Fatal("expected error: 2*window >= modulus")
	}
	if err := s.ResizeWindow(0); err == nil {
		t.Fatal("expected error: window < 1")
	}
}

// A snapshot preserves each in-flight frame's deadline and retry count, and
// the restored run produces the same trajectory as the uninterrupted one.
func TestSnapshotRestorePreservesFrameState(t *testing.T) {
	cfg := Config{
		Modulus: 8, Window: 3, Timeout: 5, Latency: 2, MaxRetries: 3,
		Loss: func(abs, attempt int) bool {
			return attempt == 0 && (abs == 0 || abs == 2)
		},
	}
	ref := mustNew(t, cfg)
	ref.Send(payloads(6)...)
	ref.Run()
	wantTraj := ref.Trajectory()
	wantDel := ref.Delivered()

	s := mustNew(t, cfg)
	s.Send(payloads(6)...)
	// Advance until at least one retransmission happened, so some frame has
	// Retries > 0 and a non-trivial deadline.
	for s.Step() {
		hasRetry := false
		for _, f := range s.Frames() {
			if f.Retries > 0 {
				hasRetry = true
			}
		}
		if hasRetry {
			break
		}
	}
	frames := s.Frames()
	hasRetry := false
	for _, f := range frames {
		if f.Retries > 0 {
			hasRetry = true
		}
		if f.Deadline < s.Now() {
			t.Fatalf("frame %+v has expired deadline at tick %d", f, s.Now())
		}
	}
	if !hasRetry {
		t.Fatal("expected at least one retried frame at snapshot time")
	}

	snap := s.Snapshot()
	s.Run() // the original continues; the snapshot must be unaffected

	r := mustNew(t, cfg)
	r.Restore(snap)
	if got := r.Frames(); !reflect.DeepEqual(got, frames) {
		t.Fatalf("restored frames %v, want %v (deadlines/retries preserved)", got, frames)
	}
	r.Run()
	if got := r.Trajectory(); !reflect.DeepEqual(got, wantTraj) {
		t.Fatalf("restored trajectory %v, want %v", got, wantTraj)
	}
	if got := r.Delivered(); !reflect.DeepEqual(got, wantDel) {
		t.Fatalf("restored delivered %v, want %v", got, wantDel)
	}
}

// Pause after every single event, restore the snapshot into a fresh
// simulator, and verify the send trajectory is identical to the reference.
func TestPauseResumeEveryEvent(t *testing.T) {
	cfg := Config{
		Modulus: 8, Window: 3, Timeout: 4, Latency: 2, MaxRetries: 3,
		Loss: func(abs, attempt int) bool {
			return (abs == 1 && attempt == 0) || (abs == 3 && attempt <= 1)
		},
	}
	input := payloads(6)

	ref := mustNew(t, cfg)
	ref.Send(input...)
	ref.Run()
	wantTraj := ref.Trajectory()
	wantDel := ref.Delivered()

	counter := mustNew(t, cfg)
	counter.Send(input...)
	steps := 0
	for counter.Step() {
		steps++
	}

	for k := 0; k <= steps; k++ {
		s := mustNew(t, cfg)
		s.Send(input...)
		for i := 0; i < k; i++ {
			s.Step()
		}
		snap := s.Snapshot()
		r := mustNew(t, cfg)
		r.Restore(snap)
		r.Run()
		if got := r.Trajectory(); !reflect.DeepEqual(got, wantTraj) {
			t.Fatalf("pause after %d events: trajectory %v, want %v", k, got, wantTraj)
		}
		if got := r.Delivered(); !reflect.DeepEqual(got, wantDel) {
			t.Fatalf("pause after %d events: delivered %v, want %v", k, got, wantDel)
		}
	}
}
