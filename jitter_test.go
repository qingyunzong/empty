package q251

import (
	"errors"
	"runtime"
	"slices"
	"testing"
	"time"
)

const (
	testRate      = 1000 // 1000 样点/秒
	testFrameSize = 10   // 每帧 10 样点 => 帧长 10ms
	testFrameDur  = 10 * time.Millisecond
)

func samplesFor(seq uint16) []int16 {
	s := make([]int16, testFrameSize)
	for i := range s {
		s[i] = int16(seq)*16 + int16(i)
	}
	return s
}

func pkt(seq uint16, ts uint32) Packet {
	return Packet{Seq: seq, Timestamp: ts, Samples: samplesFor(seq)}
}

func newTestJB(t *testing.T, clock Clock, window int) *JitterBuffer {
	t.Helper()
	jb, err := New(Config{
		SampleRate: testRate,
		FrameSize:  testFrameSize,
		Window:     window,
		Clock:      clock,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return jb
}

func recvFrame(t *testing.T, ch <-chan Frame) Frame {
	t.Helper()
	select {
	case f := <-ch:
		return f
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for frame")
		return Frame{}
	}
}

func TestConfigValidation(t *testing.T) {
	base := Config{SampleRate: testRate, FrameSize: testFrameSize, Window: 8}
	if _, err := New(base); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := []Config{
		{SampleRate: 0, FrameSize: testFrameSize, Window: 8},
		{SampleRate: testRate, FrameSize: 0, Window: 8},
		{SampleRate: testRate, FrameSize: testFrameSize, Window: 0},
		// 窗口必须小于序号半圈（32768）。
		{SampleRate: testRate, FrameSize: testFrameSize, Window: MaxWindow + 1},
	}
	for i, cfg := range bad {
		if _, err := New(cfg); err == nil {
			t.Fatalf("bad config %d accepted", i)
		}
	}
	if _, err := New(Config{SampleRate: testRate, FrameSize: testFrameSize, Window: MaxWindow}); err != nil {
		t.Fatalf("max window rejected: %v", err)
	}
}

// 双回绕：序号跨过 0xFFFF->0 两次、时戳跨过 2^32 一次，
// 全程输出序号与时戳必须连续且无丢帧。
func TestDoubleWrap(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	const total = 2*65536 + 100
	baseSeq := uint16(0xFFFE)
	baseTS := uint32(0xFFFFFFE0)

	for i := 0; i < total; i++ {
		seq := baseSeq + uint16(i)
		ts := baseTS + uint32(i)*testFrameSize
		if err := jb.Push(pkt(seq, ts)); err != nil {
			t.Fatalf("push %d: %v", i, err)
		}
		fc.Advance(testFrameDur)
		f := jb.NextFrame()
		if f.Lost {
			t.Fatalf("frame %d lost", i)
		}
		if f.Seq != seq || f.Timestamp != ts {
			t.Fatalf("frame %d: got seq=%d ts=%d, want seq=%d ts=%d", i, f.Seq, f.Timestamp, seq, ts)
		}
		if !slices.Equal(f.Samples, samplesFor(seq)) {
			t.Fatalf("frame %d: wrong payload", i)
		}
	}
	st := jb.Stats()
	if st.Delivered != total || st.Lost != 0 || st.Conflicts != 0 {
		t.Fatalf("stats: %+v", st)
	}
}

// 乱序：窗口内乱序到达的包必须按序交付。
func TestOutOfOrder(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	order := []uint16{0, 5, 2, 7, 3, 6, 1, 4}
	for _, s := range order {
		if err := jb.Push(pkt(s, uint32(s)*testFrameSize)); err != nil {
			t.Fatalf("push %d: %v", s, err)
		}
	}
	for i := uint16(0); i < 8; i++ {
		fc.Advance(testFrameDur)
		f := jb.NextFrame()
		if f.Lost || f.Seq != i || f.Timestamp != uint32(i)*testFrameSize {
			t.Fatalf("frame: got %+v, want seq=%d", f, i)
		}
		if !slices.Equal(f.Samples, samplesFor(i)) {
			t.Fatalf("frame %d: wrong payload", i)
		}
	}
	if st := jb.Stats(); st.Delivered != 8 || st.Lost != 0 {
		t.Fatalf("stats: %+v", st)
	}
}

// 到截止仍缺包：返回静音并记缺失，时戳保持连续。
func TestSilenceOnMissing(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	mustPush(t, jb, pkt(0, 0))
	fc.Advance(testFrameDur)
	f0 := jb.NextFrame()
	if f0.Lost || f0.Timestamp != 0 {
		t.Fatalf("f0: %+v", f0)
	}

	// 帧 1 不入包。
	fc.Advance(testFrameDur)
	f1 := jb.NextFrame()
	if !f1.Lost {
		t.Fatalf("f1 should be lost: %+v", f1)
	}
	if f1.Timestamp != testFrameSize || f1.Seq != 1 {
		t.Fatalf("f1 continuity broken: %+v", f1)
	}
	for _, v := range f1.Samples {
		if v != 0 {
			t.Fatalf("f1 not silence: %v", f1.Samples)
		}
	}

	mustPush(t, jb, pkt(2, 2*testFrameSize))
	fc.Advance(testFrameDur)
	f2 := jb.NextFrame()
	if f2.Lost || f2.Timestamp != 2*testFrameSize {
		t.Fatalf("f2: %+v", f2)
	}
	if st := jb.Stats(); st.Lost != 1 || st.Delivered != 2 {
		t.Fatalf("stats: %+v", st)
	}
}

// 迟到包不得修改已交付帧；重复包内容一致记重复，不同报冲突。
func TestLateAndDuplicate(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	mustPush(t, jb, pkt(0, 0))
	fc.Advance(testFrameDur)
	f0 := jb.NextFrame()
	want := slices.Clone(f0.Samples)

	// 帧 1 缺失，以静音交付。
	fc.Advance(testFrameDur)
	f1 := jb.NextFrame()
	if !f1.Lost {
		t.Fatalf("f1 should be lost")
	}

	// 帧 1 的包迟到：不得修改已交付帧，记为迟到。
	mustPush(t, jb, pkt(1, testFrameSize))
	if !slices.Equal(f0.Samples, want) {
		t.Fatal("delivered frame mutated by late packet")
	}

	// 已交付帧 0 的重复包：内容一致记重复。
	mustPush(t, jb, pkt(0, 0))
	// 内容不同报冲突。
	bad := pkt(0, 0)
	bad.Samples[0] ^= 0x7FFF
	if err := jb.Push(bad); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}

	st := jb.Stats()
	if st.Late != 1 || st.Duplicates != 1 || st.Conflicts != 1 {
		t.Fatalf("stats: %+v", st)
	}
}

// 缓冲内的重复包：内容不同报冲突，且保留先入包的内容。
func TestConflictInBuffer(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	mustPush(t, jb, pkt(0, 0))
	mustPush(t, jb, pkt(1, testFrameSize))
	dup := pkt(1, testFrameSize)
	dup.Samples[3] ^= 0x1234
	if err := jb.Push(dup); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	// 内容一致的重复包只记重复。
	mustPush(t, jb, pkt(1, testFrameSize))

	fc.Advance(testFrameDur)
	jb.NextFrame()
	fc.Advance(testFrameDur)
	f := jb.NextFrame()
	if !slices.Equal(f.Samples, samplesFor(1)) {
		t.Fatal("conflicting duplicate overwrote buffered packet")
	}
	st := jb.Stats()
	if st.Conflicts != 1 || st.Duplicates != 1 {
		t.Fatalf("stats: %+v", st)
	}
}

// 时戳与序号不一致的包被拒绝。
func TestTimestampSkew(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	mustPush(t, jb, pkt(10, 1000))
	if err := jb.Push(pkt(11, 1000+testFrameSize+1)); !errors.Is(err, ErrTimestampSkew) {
		t.Fatalf("want ErrTimestampSkew, got %v", err)
	}
	if jb.Buffered() != 1 {
		t.Fatalf("skewed packet entered buffer: %d", jb.Buffered())
	}
}

// 缓冲上限：超出活动窗口的包被丢弃，Buffered 恒不超过 Window。
func TestBufferBound(t *testing.T) {
	fc := NewFakeClock()
	const window = 8
	jb := newTestJB(t, fc, window)

	mustPush(t, jb, pkt(0, 0))
	for i := uint16(1); i < window+10; i++ {
		mustPush(t, jb, pkt(i, uint32(i)*testFrameSize))
	}
	if got := jb.Buffered(); got != window {
		t.Fatalf("Buffered=%d, want %d", got, window)
	}
	if st := jb.Stats(); st.DroppedAhead != 10 {
		t.Fatalf("DroppedAhead=%d, want 10", st.DroppedAhead)
	}
	for i := uint16(0); i < window; i++ {
		fc.Advance(testFrameDur)
		f := jb.NextFrame()
		if f.Lost || f.Seq != i {
			t.Fatalf("frame %+v, want seq=%d", f, i)
		}
	}
	if got := jb.Buffered(); got != 0 {
		t.Fatalf("Buffered=%d after drain", got)
	}
}

// 流重置：清空旧包，唤醒阻塞的取帧方，新代际由首包重建基准。
func TestStreamReset(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 8)

	mustPush(t, jb, pkt(100, 1000))
	mustPush(t, jb, pkt(101, 1010))
	mustPush(t, jb, pkt(102, 1020))

	frames := make(chan Frame, 2)
	go func() {
		frames <- jb.NextFrame() // 立即交付帧 100
		frames <- jb.NextFrame() // 阻塞在帧 101 的截止定时器上
	}()
	if f := recvFrame(t, frames); f.Seq != 100 || f.Lost {
		t.Fatalf("first frame: %+v", f)
	}
	time.Sleep(20 * time.Millisecond) // 让第二个 NextFrame 进入定时等待

	jb.Reset()
	if jb.Buffered() != 0 {
		t.Fatalf("old packets survived reset: %d", jb.Buffered())
	}
	if jb.Generation() != 1 || jb.Stats().Resets != 1 {
		t.Fatalf("generation not switched")
	}
	time.Sleep(20 * time.Millisecond) // Reset 唤醒后取帧方应等待新基准

	// 新代际首包重建基准。
	mustPush(t, jb, pkt(5000, 77))
	f := recvFrame(t, frames)
	if f.Seq != 5000 || f.Timestamp != 77 || f.Lost {
		t.Fatalf("frame after reset: %+v", f)
	}
	if !slices.Equal(f.Samples, samplesFor(5000)) {
		t.Fatal("wrong payload after reset")
	}

	// 旧代际的包不应残留：缓冲里只有刚交付前的那一包。
	if got := jb.Buffered(); got != 0 {
		t.Fatalf("Buffered=%d after reset cycle", got)
	}
}

// 取帧与入包竞争：拉帧、推包、推进时钟三方并发，
// 输出序号与时戳必须连续，交付数+缺失数等于总帧数。
func TestPushPullRace(t *testing.T) {
	fc := NewFakeClock()
	jb := newTestJB(t, fc, 16)

	const n = 500
	frames := make([]Frame, 0, n)
	done := make(chan struct{})

	go func() { // 取帧方
		defer close(done)
		for i := 0; i < n; i++ {
			frames = append(frames, jb.NextFrame())
		}
	}()
	go func() { // 入包方：尽量赶在截止前入包
		for i := 0; i < n; i++ {
			for fc.Now() < time.Duration(i-1)*testFrameDur {
				runtime.Gosched()
			}
			_ = jb.Push(pkt(uint16(i), uint32(i)*testFrameSize))
		}
	}()

	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-done:
			goto finished
		case <-timer.C:
			t.Fatal("timeout: push/pull race deadlocked")
		default:
		}
		fc.Advance(time.Millisecond)
		runtime.Gosched()
	}
finished:

	for i, f := range frames {
		if f.Seq != uint16(i) || f.Timestamp != uint32(i)*testFrameSize {
			t.Fatalf("frame %d breaks continuity: %+v", i, f)
		}
	}
	st := jb.Stats()
	if st.Delivered+st.Lost != n {
		t.Fatalf("Delivered+Lost=%d, want %d (%+v)", st.Delivered+st.Lost, n, st)
	}
}

// 真实时钟冒烟：基准帧截止即交付。
func TestRealClockSmoke(t *testing.T) {
	jb, err := New(Config{SampleRate: 8000, FrameSize: 160, Window: 4})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := make([]int16, 160)
	for i := range s {
		s[i] = int16(i)
	}
	if err := jb.Push(Packet{Seq: 7, Timestamp: 70, Samples: s}); err != nil {
		t.Fatalf("Push: %v", err)
	}
	done := make(chan Frame, 1)
	go func() { done <- jb.NextFrame() }()
	f := recvFrame(t, done)
	if f.Lost || f.Seq != 7 || f.Timestamp != 70 || !slices.Equal(f.Samples, s) {
		t.Fatalf("frame: %+v", f)
	}
}

func mustPush(t *testing.T, jb *JitterBuffer, p Packet) {
	t.Helper()
	if err := jb.Push(p); err != nil {
		t.Fatalf("push seq=%d: %v", p.Seq, err)
	}
}
