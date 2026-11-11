package q255

import (
	"testing"
)

const (
	trackVideo = "video"
	trackAudio = "audio"
)

func testConfig(tbVideo, tbAudio Timestamp, sink Sink, end *Timestamp) Config {
	return Config{
		Tracks: []TrackConfig{
			{ID: trackVideo, TimeBase: tbVideo, IsVideo: true},
			{ID: trackAudio, TimeBase: tbAudio, IsVideo: false},
		},
		End:  end,
		Sink: sink,
	}
}

func mustPush(t *testing.T, s *Submitter, sample Sample) {
	t.Helper()
	if err := s.Push(sample); err != nil {
		t.Fatalf("Push(%+v): %v", sample, err)
	}
}

func dtsList(samples []Sample) []int64 {
	out := make([]int64, len(samples))
	for i, sample := range samples {
		out[i] = sample.DTS
	}
	return out
}

func videoFrame(dts, pts int64, key bool) Sample {
	return Sample{TrackID: trackVideo, DTS: dts, PTS: pts, Duration: 3003, Keyframe: key}
}

func audioFrame(dts int64) Sample {
	return Sample{TrackID: trackAudio, DTS: dts, PTS: dts, Duration: 1024}
}

// Different track time bases: boundaries must be decided by exact rational
// comparison, including an audio sample exactly on a cut and an audio sample
// that would land on the wrong side after naive millisecond truncation.
func TestDifferentTimeBases(t *testing.T) {
	tbVideo := Timestamp{Num: 1, Den: 90000}
	tbAudio := Timestamp{Num: 1, Den: 48000}

	var got []*Shard
	sink := func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}
	end := Timestamp{Num: 270000, Den: 90000} // 3s in video ticks
	sub, err := New(testConfig(tbVideo, tbAudio, sink, &end))
	if err != nil {
		t.Fatal(err)
	}

	// Audio at 48000 Hz: 48000 ticks == 1s exactly (cut at 90000 video ticks).
	mustPush(t, sub, audioFrame(0))      // 0s
	mustPush(t, sub, audioFrame(48000))  // exactly 1s -> shard 1
	mustPush(t, sub, audioFrame(48001))  // 1.00002s, just past 1s -> shard 1
	mustPush(t, sub, audioFrame(95999))  // ~1.99998s, still shard 1
	mustPush(t, sub, audioFrame(96000))  // exactly 2s -> shard 2
	mustPush(t, sub, audioFrame(144000)) // exactly 3s -> tail shard 2

	mustPush(t, sub, videoFrame(0, 0, true)) // cut 0
	mustPush(t, sub, videoFrame(3003, 6006, false))
	mustPush(t, sub, videoFrame(90000, 90000, true)) // cut 1s
	mustPush(t, sub, videoFrame(93003, 96006, false))
	mustPush(t, sub, videoFrame(180000, 180000, true)) // cut 2s
	mustPush(t, sub, videoFrame(183003, 186006, false))
	mustPush(t, sub, videoFrame(267000, 267000, false)) // crosses 3s end

	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	if len(got) != 3 {
		t.Fatalf("shard count = %d, want 3", len(got))
	}

	wantAudio := [][]int64{
		{0},
		{48000, 48001, 95999},
		{96000, 144000},
	}
	for i, want := range wantAudio {
		if eq := dtsList(got[i].Samples[trackAudio]); !equalInt64(eq, want) {
			t.Errorf("shard %d audio DTS = %v, want %v", i, eq, want)
		}
	}

	wantVideo := [][]int64{
		{0, 3003},
		{90000, 93003},
		{180000, 183003, 267000},
	}
	for i, want := range wantVideo {
		if eq := dtsList(got[i].Samples[trackVideo]); !equalInt64(eq, want) {
			t.Errorf("shard %d video DTS = %v, want %v", i, eq, want)
		}
	}

	// Interval boundaries are exact rationals in the video time base.
	wantBounds := []struct{ start, end int64 }{
		{0, 90000},
		{90000, 180000},
		{180000, 270000},
	}
	for i, b := range wantBounds {
		if got[i].Start.Num != b.start || got[i].End.Num != b.end || got[i].End.Den != 90000 {
			t.Errorf("shard %d bounds = %+v, want [%d,%d)@90000", i, got[i].End, b.start, b.end)
		}
		if got[i].Index != i {
			t.Errorf("shard %d Index = %d", i, got[i].Index)
		}
	}
}

// B-frames: PTS reorders while DTS stays increasing. PTS must be preserved
// verbatim and sharding must follow DTS only.
func TestBFramesPTSReorder(t *testing.T) {
	tb := Timestamp{Num: 1, Den: 90000}
	var got []*Shard
	sub, err := New(testConfig(tb, tb, func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}, &Timestamp{Num: 270000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}

	// Display order PTS: 3003, 6006, 90000 ... but push order uses increasing DTS.
	mustPush(t, sub, videoFrame(0, 3003, true))
	mustPush(t, sub, videoFrame(3003, 90000, false))
	mustPush(t, sub, videoFrame(6006, 6006, false))
	mustPush(t, sub, videoFrame(90000, 93003, true))
	mustPush(t, sub, videoFrame(93003, 99006, false))
	mustPush(t, sub, videoFrame(96006, 96006, false))
	mustPush(t, sub, videoFrame(267000, 267000, false)) // crosses 3s end

	// Audio still participates so the two-track water mark logic is exercised.
	mustPush(t, sub, audioFrame(0))
	mustPush(t, sub, audioFrame(48000))
	mustPush(t, sub, audioFrame(96000))
	mustPush(t, sub, audioFrame(144000))
	mustPush(t, sub, audioFrame(270000)) // crosses 3s end

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
	firstVideo := got[0].Samples[trackVideo]
	wantPTS := []int64{3003, 90000, 6006}
	gotPTS := make([]int64, len(firstVideo))
	for i, sample := range firstVideo {
		gotPTS[i] = sample.PTS
	}
	if !equalInt64(gotPTS, wantPTS) {
		t.Errorf("first shard PTS = %v, want %v (PTS reordering preserved)", gotPTS, wantPTS)
	}
	if !equalInt64(dtsList(firstVideo), []int64{0, 3003, 6006}) {
		t.Errorf("first shard video DTS = %v, want [0 3003 6006]", dtsList(firstVideo))
	}
}

// An audio gap before a later keyframe must produce an empty audio slice in
// the affected shard; the component must not fabricate filler samples and the
// real samples must remain untouched.
func TestAudioGapBeforeKeyframe(t *testing.T) {
	tbVideo := Timestamp{Num: 1, Den: 90000}
	tbAudio := Timestamp{Num: 1, Den: 48000}
	var got []*Shard
	sub, err := New(testConfig(tbVideo, tbAudio, func(sh *Shard) error {
		got = append(got, sh)
		return nil
	}, &Timestamp{Num: 270000, Den: 90000}))
	if err != nil {
		t.Fatal(err)
	}

	mustPush(t, sub, videoFrame(0, 0, true))
	mustPush(t, sub, videoFrame(90000, 90000, true))
	mustPush(t, sub, videoFrame(180000, 180000, true))
	mustPush(t, sub, videoFrame(183003, 183003, false))
	mustPush(t, sub, videoFrame(267000, 267000, false)) // crosses 3s end

	// Only two audio frames: one in the first interval, one after 2s.
	// Nothing at all covers the [1s,2s) interval.
	mustPush(t, sub, audioFrame(24000))  // 0.5s -> shard 0
	mustPush(t, sub, audioFrame(100000)) // ~2.083s -> shard 2
	mustPush(t, sub, audioFrame(144000)) // 3s -> shard 2, crosses end

	if err := sub.EndTrack(trackAudio); err != nil {
		t.Fatal(err)
	}
	if err := sub.EndTrack(trackVideo); err != nil {
		t.Fatal(err)
	}
	if err := sub.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	if len(got) != 3 {
		t.Fatalf("shard count = %d, want 3", len(got))
	}
	if len(got[1].Samples[trackAudio]) != 0 {
		t.Errorf("middle shard audio samples = %d, want 0 (gap, no fake samples)",
			len(got[1].Samples[trackAudio]))
	}
	if !equalInt64(dtsList(got[0].Samples[trackAudio]), []int64{24000}) {
		t.Errorf("first shard audio = %v, want [24000]", dtsList(got[0].Samples[trackAudio]))
	}
	if !equalInt64(dtsList(got[2].Samples[trackAudio]), []int64{100000, 144000}) {
		t.Errorf("last shard audio = %v, want [100000 144000]", dtsList(got[2].Samples[trackAudio]))
	}

	// Every published sample is one the caller actually pushed.
	totalAudio := 0
	for _, sh := range got {
		totalAudio += len(sh.Samples[trackAudio])
	}
	if totalAudio != 3 {
		t.Errorf("total audio samples = %d, want 3 (no fabrication)", totalAudio)
	}
}

func equalInt64(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
