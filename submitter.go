// Package q255 implements an exact, multi-track media shard submitter.
//
// Audio and video samples carry their own DTS/PTS/duration in their own track
// time base. Shard boundaries are derived from video keyframe DTS values, and
// every sample is assigned to a shard according to the left-closed/right-open
// DTS interval it falls into. All time comparisons are performed on exact
// rational numbers (track time base numerator/denominator) via integer cross
// multiplication; values are never converted to milliseconds or any other
// common scale, so no rounding can move a sample across a boundary.
package q255

import (
	"errors"
	"sync"
)

// Timestamp is an exact point on a track timeline.
//
// The represented time is (Num/Den)*unit where unit is the owning track's
// time base. Num may be negative (PTS reordering); comparisons never divide.
type Timestamp struct {
	Num int64
	Den int64
}

// Sample is one audio or video sample. PTS may go backwards (B-frames) and is
// stored verbatim; shard placement uses DTS only.
type Sample struct {
	TrackID  string
	DTS      int64
	PTS      int64
	Duration int64
	Keyframe bool
}

// Shard is one finalized, left-closed/right-open DTS interval. Samples retain
// their original timestamps and ordering; the component never fabricates
// filler samples, so a track may legitimately contribute zero samples.
type Shard struct {
	Index   int
	Start   Timestamp
	End     Timestamp
	Samples map[string][]Sample
}

// Sink receives finalized shards. Calls happen strictly in shard order from a
// single serialized context, so one Sink call is the atomic publication point:
// either the whole shard lands or an error aborts the pipeline.
type Sink func(*Shard) error

// TrackConfig declares one input track and its time base.
type TrackConfig struct {
	ID       string
	TimeBase Timestamp
	// IsVideo marks the track whose keyframes define the cut points.
	IsVideo bool
}

// Config configures a Submitter.
type Config struct {
	Tracks []TrackConfig
	// End is the optional end-of-film instant, expressed in the video track
	// time base. When set, every track must reach it before the final shard is
	// released; a track ending earlier is reported as an error.
	End  *Timestamp
	Sink Sink
}

type shardState struct {
	index     int
	start     Timestamp
	end       Timestamp
	open      bool
	published bool
	samples   map[string][]Sample
}

type trackState struct {
	den      int64
	isVideo  bool
	ended    bool
	dtsMark  int64 // greatest DTS observed on the track
	endMark  int64 // greatest DTS+Duration observed on the track
	lastDTS  int64
	haveLast bool
}

type cut struct {
	num int64
	den int64
}

// Submitter accepts interleaved pushes from the audio and video tracks. Its
// methods are safe for concurrent use.
type Submitter struct {
	mu      sync.Mutex
	tracks  map[string]*trackState
	order   []string
	videoTB Timestamp
	cuts    []cut
	shards  []*shardState
	pending map[string][]Sample // samples seen before the first cut
	end     *Timestamp
	sink    Sink

	doneCh chan struct{}
	once   sync.Once
	err    error
}

// New validates the configuration and creates a Submitter. Exactly one video
// track is required.
func New(cfg Config) (*Submitter, error) {
	if cfg.Sink == nil {
		return nil, errors.New("q255: sink is required")
	}
	if len(cfg.Tracks) == 0 {
		return nil, errors.New("q255: at least one track is required")
	}

	s := &Submitter{
		tracks:  make(map[string]*trackState),
		pending: make(map[string][]Sample),
		end:     cfg.End,
		sink:    cfg.Sink,
		doneCh:  make(chan struct{}),
	}

	videoCount := 0
	for _, tc := range cfg.Tracks {
		if tc.ID == "" {
			return nil, errors.New("q255: track id must not be empty")
		}
		if _, dup := s.tracks[tc.ID]; dup {
			return nil, errors.New("q255: duplicate track id: " + tc.ID)
		}
		if tc.TimeBase.Den <= 0 {
			return nil, errors.New("q255: track time base denominator must be positive")
		}
		if tc.TimeBase.Num <= 0 {
			return nil, errors.New("q255: track time base numerator must be positive")
		}
		s.tracks[tc.ID] = &trackState{den: tc.TimeBase.Den, isVideo: tc.IsVideo}
		s.order = append(s.order, tc.ID)
		if tc.IsVideo {
			videoCount++
			s.videoTB = tc.TimeBase
		}
	}
	if videoCount != 1 {
		return nil, errors.New("q255: exactly one video track is required")
	}
	return s, nil
}

// Push accepts one sample. Video keyframes register cut points; every sample is
// placed by its DTS into the containing left-closed/right-open interval.
// DTS must be non-decreasing within a track; PTS is not constrained.
func (s *Submitter) Push(sample Sample) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.err != nil {
		return s.err
	}
	tr, ok := s.tracks[sample.TrackID]
	if !ok {
		return s.failLocked(errors.New("q255: unknown track: " + sample.TrackID))
	}
	if tr.ended {
		return s.failLocked(errors.New("q255: push after end of track: " + sample.TrackID))
	}
	if tr.haveLast && sample.DTS < tr.lastDTS {
		return s.failLocked(errors.New("q255: DTS must be non-decreasing within a track"))
	}
	if sample.Duration < 0 {
		return s.failLocked(errors.New("q255: sample duration must not be negative"))
	}

	tr.haveLast = true
	tr.lastDTS = sample.DTS
	if sample.DTS > tr.dtsMark {
		tr.dtsMark = sample.DTS
	}
	if frontier := sample.DTS + sample.Duration; frontier > tr.endMark {
		tr.endMark = frontier
	}

	if tr.isVideo && sample.Keyframe {
		if err := s.registerCutLocked(sample.DTS); err != nil {
			return s.failLocked(err)
		}
	}

	if len(s.shards) == 0 {
		// No cut point known yet: hold samples without inventing any data.
		s.pending[sample.TrackID] = append(s.pending[sample.TrackID], sample)
		return nil
	}

	if err := s.placeLocked(sample); err != nil {
		return s.failLocked(err)
	}
	s.sealLocked()
	return s.err
}

// EndTrack marks one track as finished. After every track has ended, any
// samples that never received a following cut point are flushed into a final
// shard and the last wait is released.
func (s *Submitter) EndTrack(trackID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.err != nil {
		return s.err
	}
	tr, ok := s.tracks[trackID]
	if !ok {
		return s.failLocked(errors.New("q255: unknown track: " + trackID))
	}
	if tr.ended {
		return nil
	}
	tr.ended = true

	if s.end != nil {
		// Exact end-of-film check in this track's own time base.
		if cmpRational(tr.endMark, tr.den, s.end.Num, s.end.Den) < 0 {
			return s.failLocked(errors.New("q255: track ended before end of film: " + trackID))
		}
	}

	if s.allEndedLocked() {
		s.finishLocked()
	}
	return s.err
}

// Wait blocks until every track has ended and all finalized shards have been
// delivered to the sink, then returns the first error encountered.
func (s *Submitter) Wait() error {
	<-s.doneCh
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *Submitter) allEndedLocked() bool {
	for _, tr := range s.tracks {
		if !tr.ended {
			return false
		}
	}
	return true
}

func (s *Submitter) failLocked(err error) error {
	if s.err == nil {
		s.err = err
		s.once.Do(func() { close(s.doneCh) })
	}
	return s.err
}

func (s *Submitter) registerCutLocked(dts int64) error {
	c := cut{num: dts, den: s.videoTB.Den}
	if len(s.cuts) > 0 {
		last := s.cuts[len(s.cuts)-1]
		cmp := cmpRational(c.num, c.den, last.num, last.den)
		if cmp < 0 {
			return errors.New("q255: video keyframe DTS must be non-decreasing")
		}
		if cmp == 0 {
			return nil // duplicate cut at the same instant
		}
	}
	s.cuts = append(s.cuts, c)

	if len(s.shards) == 0 {
		// The first keyframe opens shard 0 at the cut. All samples buffered
		// before any cut were known move into it; the triggering keyframe
		// itself is placed by the caller's normal placeLocked step.
		first := &shardState{
			index:   0,
			start:   Timestamp{Num: c.num, Den: c.den},
			end:     Timestamp{Num: c.num, Den: c.den},
			open:    true,
			samples: make(map[string][]Sample),
		}
		s.shards = append(s.shards, first)
		for _, id := range s.order {
			first.samples[id] = append(first.samples[id], s.pending[id]...)
			delete(s.pending, id)
		}
		return nil
	}

	// Close the current open interval at the new cut and open the next one.
	cur := s.shards[len(s.shards)-1]
	if !cur.open {
		return errors.New("q255: internal error: no open shard for cut")
	}
	for _, id := range s.order {
		cur.samples[id] = append(cur.samples[id], s.pending[id]...)
		delete(s.pending, id)
	}
	cur.open = false
	cur.end = Timestamp{Num: c.num, Den: c.den}
	next := &shardState{
		index:   cur.index + 1,
		start:   Timestamp{Num: c.num, Den: c.den},
		end:     Timestamp{Num: c.num, Den: c.den},
		open:    true,
		samples: make(map[string][]Sample),
	}

	// Samples of the old interval whose DTS already reaches the new cut move
	// into the next interval (left-closed/right-open split, exact comparison).
	for _, id := range s.order {
		var kept []Sample
		for _, sample := range cur.samples[id] {
			tr := s.tracks[id]
			if cmpRational(sample.DTS, tr.den, c.num, c.den) >= 0 {
				next.samples[id] = append(next.samples[id], sample)
			} else {
				kept = append(kept, sample)
			}
		}
		cur.samples[id] = kept
	}
	s.shards = append(s.shards, next)
	s.sealLocked()
	return s.err
}

func (s *Submitter) placeLocked(sample Sample) error {
	tr := s.tracks[sample.TrackID]
	for idx := len(s.shards) - 1; idx >= 0; idx-- {
		sh := s.shards[idx]
		belowStart := idx > 0 && cmpRational(sample.DTS, tr.den, sh.start.Num, sh.start.Den) < 0
		// The first shard absorbs any samples predating the first keyframe
		// instead of dropping them or synthesizing a boundary.
		if belowStart {
			continue
		}
		pastEnd := !sh.open && cmpRational(sample.DTS, tr.den, sh.end.Num, sh.end.Den) >= 0
		if pastEnd {
			continue
		}
		if sh.published {
			return errors.New("q255: sample DTS falls inside an already published shard")
		}
		sh.samples[sample.TrackID] = append(sh.samples[sample.TrackID], sample)
		return nil
	}
	return errors.New("q255: sample DTS precedes the first cut point")
}

// sealLocked publishes every fully closed shard whose right boundary has been
// crossed by every track's DTS water mark. Publication runs in shard order
// under the lock, so each sink call is atomic and ordering is guaranteed.
func (s *Submitter) sealLocked() {
	for _, sh := range s.shards {
		if sh.open || sh.published {
			continue
		}
		ready := true
		for _, id := range s.order {
			tr := s.tracks[id]
			if cmpRational(tr.dtsMark, tr.den, sh.end.Num, sh.end.Den) < 0 {
				ready = false
				break
			}
		}
		if !ready {
			return
		}
		if err := s.publishLocked(sh); err != nil {
			s.failLocked(err)
			return
		}
		sh.published = true
	}
}

func (s *Submitter) publishLocked(sh *shardState) error {
	published := &Shard{
		Index:   sh.index,
		Start:   sh.start,
		End:     sh.end,
		Samples: make(map[string][]Sample, len(s.order)),
	}
	for _, id := range s.order {
		// Preserve the empty slice shape for tracks with a real gap instead of
		// synthesizing samples; nil simply means nothing arrived.
		samples := sh.samples[id]
		if samples == nil {
			samples = []Sample{}
		}
		published.Samples[id] = samples
	}
	return s.sink(published)
}

func (s *Submitter) finishLocked() {
	// No cut point ever arrived: emit a single unbounded shard for all samples.
	if len(s.shards) == 0 {
		sh := &shardState{
			index:   0,
			start:   Timestamp{Num: 0, Den: s.videoTB.Den},
			end:     Timestamp{Num: 0, Den: s.videoTB.Den},
			open:    false,
			samples: make(map[string][]Sample),
		}
		for _, id := range s.order {
			sh.samples[id] = s.pending[id]
			delete(s.pending, id)
		}
		s.shards = append(s.shards, sh)
	}

	// The last open interval is closed at the end of film when known; without
	// an explicit end it remains an unbounded tail (End zero-value sentinel).
	last := s.shards[len(s.shards)-1]
	if last.open {
		last.open = false
		if s.end != nil {
			last.end = *s.end
		}
	}

	for _, sh := range s.shards {
		if sh.published {
			continue
		}
		if err := s.publishLocked(sh); err != nil {
			s.failLocked(err)
			return
		}
		sh.published = true
	}
	s.once.Do(func() { close(s.doneCh) })
}
