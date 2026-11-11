package q255

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// One track runs ahead: a fully closed shard must stay unpublished until the
// slow track's DTS water mark crosses the same boundary. No filler data is
// generated to close the gap.
func TestSingleTrackDelayHoldsShard(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	published := make(chan *Shard, 16)
	sub, err := New(testConfig(tb, tb, func(sh *Shard) error {
		published <- sh
		return nil
	}, &Timestamp{Num: 270000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}

	// All video first, including two cuts.
	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, videoFrame(90000, 90000, true))
	mustPush(t, sub, videoFrame(180000, 180000, true))
	mustPush(t, sub, videoFrame(267000, 267000, false)) // crosses 3s end

	select {
	case sh := <-published:
		t.Fatalf("shard %d published before audio water mark advanced", sh.Index)
	case <-time.After(20 * time.Millisecond):
	}

	// Audio crosses the 1s boundary: shard 0 may now be published, exactly once.
	mustPush(t, sub, audioFrame(0))
	mustPush(t, sub, audioFrame(90000))

	select {
	case sh := <-published:
		if sh.Index != 0 {
			t.Fatalf("first published shard Index = %d, want 0", sh.Index)
		}
	case <-time.After(time.Second):
		t.Fatal("shard 0 not published after audio crossed boundary")
	}

	select {
	case sh := <-published:
		t.Fatalf("shard %d published before audio crossed 2s boundary", sh.Index)
	case <-time.After(20 * time.Millisecond):
	}

	// Advancing the audio water mark past 2s releases shard 1 as well.
	mustPush(t, sub, audioFrame(180000))
	select {
	case sh := <-published:
		if sh.Index != 1 {
			t.Fatalf("second published shard Index = %d, want 1", sh.Index)
		}
	case <-time.After(time.Second):
		t.Fatal("shard 1 not published after audio crossed 2s boundary")
	}

	mustPush(t, sub, audioFrame(270000)) // crosses end so EndTrack passes

	// Ending both tracks releases the remaining tail shards in order.
	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	// Shards 0 and 1 were already consumed above in arrival order; only the
	// final tail shard remains buffered.
	close(published)

	var indices []int
	for sh := range published {
		indices = append(indices, sh.Index)
	}
	if len(indices) != 1 || indices[0] != 2 {
		t.Fatalf("remaining published indices = %v, want [2]", indices)
	}
}

// The end marker releases the final wait: Wait blocks while a track is open
// even after all middle shards are sealed, then returns once EndTrack lands.
func TestEndMarkerReleasesFinalWait(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	sub, err := New(testConfig(tb, tb, func(*Shard) error { return nil },
		&Timestamp{Num: 270000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}

	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, videoFrame(90000, 90000, true))
	mustPush(t, sub, videoFrame(267000, 267000, false)) // crosses 3s end
	mustPush(t, sub, audioFrame(0))
	mustPush(t, sub, audioFrame(90000))
	mustPush(t, sub, audioFrame(270000))

	waitErr := make(chan error, 1)
	go func() { waitErr <- sub.Wait() }()

	select {
	case err := <-waitErr:
		t.Fatalf("Wait returned before end markers: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-waitErr:
		if err != nil {
			t.Fatalf("Wait: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not release after end markers")
	}
}

// A track ending before the configured end of film is an error, not a silent
// padding of fake samples.
func TestEndedBeforeEndOfFilmErrors(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	sub, err := New(testConfig(tb, tb, func(*Shard) error { return nil },
		&Timestamp{Num: 270000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, audioFrame(0))

	err = sub.EndTrack(trackAudio)
	if err == nil {
		t.Fatal("expected error when audio ends before end of film")
	}
	if err := sub.Wait(); err == nil {
		t.Fatal("Wait must surface the end-of-film error")
	}
}

func TestPushAfterEndTrackErrors(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	sub, err := New(testConfig(tb, tb, func(*Shard) error { return nil }, nil))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, videoFrame(0, 0, true))
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Push(videoFrame(3003, 3003, false)); err == nil {
		t.Fatal("expected error on push after EndTrack")
	}
}

func TestDecreasingDTSErrors(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	sub, err := New(testConfig(tb, tb, func(*Shard) error { return nil }, nil))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, audioFrame(1024))
	if err := sub.Push(audioFrame(512)); err == nil {
		t.Fatal("expected error on decreasing DTS")
	}
}

// Two keyframes at the same DTS register one cut, and both frames are kept.
func TestDuplicateKeyframeDTS(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	var got []*Shard
	sub, err := New(testConfig(tb, tb, func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}, nil))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, videoFrame(0, 3003, true)) // same DTS, different PTS
	mustPush(t, sub, audioFrame(0))
	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("shard count = %d, want 1", len(got))
	}
	if len(got[0].Samples[trackVideo]) != 2 {
		t.Fatalf("video samples = %d, want 2 (duplicate keyframe kept)",
			len(got[0].Samples[trackVideo]))
	}
}

// Concurrent pushers exercising the full pipeline under the race detector.
func TestConcurrentPushes(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	var mu sync.Mutex
	count := 0
	sub, err := New(testConfig(tb, tb, func(sh *Shard) error {
		mu.Lock()
		count += len(sh.Samples[trackVideo]) + len(sh.Samples[trackAudio])
		mu.Unlock()
		return nil
	}, &Timestamp{Num: 180000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}

	const frames = 200
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := int64(0); i < frames; i++ {
			_ = sub.Push(videoFrame(i*3003, i*3003, i%25 == 0))
		}
	}()
	go func() {
		defer wg.Done()
		for i := int64(0); i < frames; i++ {
			_ = sub.Push(audioFrame(i * 1024))
		}
	}()
	wg.Wait()

	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if count != 2*frames {
		t.Fatalf("published sample count = %d, want %d (no loss, no fabrication)", count, 2*frames)
	}
}

// A sink failure aborts the pipeline and is surfaced through Wait.
func TestSinkErrorAborts(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	boom := errors.New("boom")
	calls := 0
	sub, err := New(testConfig(tb, tb, func(*Shard) error {
		calls++
		return boom
	}, nil))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, videoFrame(90000, 90000, true))
	mustPush(t, sub, audioFrame(0))
	mustPush(t, sub, audioFrame(89000)) // stays inside shard 0: nothing seals yet
	// End-of-film flush attempts the single atomic publication, which fails
	// once and aborts the pipeline instead of touching the sink again.
	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatalf("audio EndTrack: %v", err)
	}
	err = sub.EndTrack(trackVideo)
	if !errors.Is(err, boom) {
		t.Fatalf("EndTrack error = %v, want boom", err)
	}
	if err := sub.Wait(); !errors.Is(err, boom) {
		t.Fatalf("Wait error = %v, want boom", err)
	}
	if calls != 1 {
		t.Fatalf("sink calls = %d, want 1 (atomic abort after first failure)", calls)
	}
}

// Without any keyframe the held samples are flushed as one tail shard on end,
// never dropped or padded.
func TestNoKeyframeFlushesTailShard(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	var got []*Shard
	sub, err := New(testConfig(tb, tb, func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}, nil))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, audioFrame(0))
	mustPush(t, sub, audioFrame(1024))
	mustPush(t, sub, videoFrame(0, 0, false))
	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("shard count = %d, want 1", len(got))
	}
	if len(got[0].Samples[trackAudio]) != 2 || len(got[0].Samples[trackVideo]) != 1 {
		t.Fatalf("tail shard samples = audio %d video %d, want 2 and 1",
			len(got[0].Samples[trackAudio]), len(got[0].Samples[trackVideo]))
	}
}

// Samples arriving before the first keyframe belong to the first shard.
func TestSamplesBeforeFirstKeyframe(t *testing.T) {
	tbVideo := Timestamp{Num: 1, Den: 90000}
	tbAudio := Timestamp{Num: 1, Den: 48000}
	var got []*Shard
	sub, err := New(testConfig(tbVideo, tbAudio, func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}, &Timestamp{Num: 180000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}
	mustPush(t, sub, audioFrame(100)) // pushed before any cut exists
	mustPush(t, sub, videoFrame(3003, 3003, false))
	mustPush(t, sub, videoFrame(90000, 90000, true)) // first cut at 1s
	mustPush(t, sub, audioFrame(96000))
	mustPush(t, sub, videoFrame(177000, 177000, true)) // second cut, opens shard 1
	mustPush(t, sub, audioFrame(97024))                // crosses 2s end in 48kHz

	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("shard count = %d, want 2", len(got))
	}
	if !equalInt64(dtsList(got[0].Samples[trackAudio]), []int64{100}) {
		t.Errorf("first shard audio = %v, want [100]", dtsList(got[0].Samples[trackAudio]))
	}
	if !equalInt64(dtsList(got[0].Samples[trackVideo]), []int64{3003, 90000}) {
		t.Errorf("first shard video = %v, want [3003 90000] (opening keyframe starts shard 0)",
			dtsList(got[0].Samples[trackVideo]))
	}
	if !equalInt64(dtsList(got[1].Samples[trackVideo]), []int64{177000}) {
		t.Errorf("second shard video = %v, want [177000] (later cut moves at-cut samples here)",
			dtsList(got[1].Samples[trackVideo]))
	}
	if !equalInt64(dtsList(got[1].Samples[trackAudio]), []int64{96000, 97024}) {
		t.Errorf("second shard audio = %v, want [96000 97024]", dtsList(got[1].Samples[trackAudio]))
	}
}
