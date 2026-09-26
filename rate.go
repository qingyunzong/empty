package counterrate

import (
	"errors"
	"time"
)

// RateResult describes a counter rate over one window.
type RateResult struct {
	Rate      float64       // increase per second over the whole window
	Increase  float64       // summed positive deltas inside the window
	Duration  time.Duration // window length
	Uncertain bool          // an unmarked reset (value rollback) was seen
	Resets    int           // marked restarts inside the window
	Samples   int           // real samples inside the window
}

// ErrEmptyWindow is returned for non-positive windows.
var ErrEmptyWindow = errors.New("counterrate: window end must be after start")

// valueAt interpolates the counter at t inside one segment.
// Inside the sample range it linearly interpolates between neighbours;
// outside it clamps to the nearest sample (no extrapolation).
func valueAt(seg segment, t time.Time) float64 {
	if !t.After(seg[0].Ts) {
		return seg[0].Value
	}
	if !t.Before(seg[len(seg)-1].Ts) {
		return seg[len(seg)-1].Value
	}
	for i := 1; i < len(seg); i++ {
		if !seg[i].Ts.Before(t) {
			prev, next := seg[i-1], seg[i]
			frac := float64(t.Sub(prev.Ts)) / float64(next.Ts.Sub(prev.Ts))
			return prev.Value + frac*(next.Value-prev.Value)
		}
	}
	return seg[len(seg)-1].Value
}

// WindowRate computes the counter rate over [start, end].
//
// The window is clipped against every segment. Boundary values are
// interpolated (or clamped at the data edges). Positive deltas are summed;
// a negative delta without a restart marker is skipped and flags the result
// Uncertain instead of fabricating a negative rate.
func (s *Series) WindowRate(start, end time.Time) (RateResult, error) {
	if !end.After(start) {
		return RateResult{}, ErrEmptyWindow
	}
	segs, err := s.Resolve()
	if err != nil {
		return RateResult{}, err
	}
	res := RateResult{Duration: end.Sub(start)}
	for i, seg := range segs {
		if seg[len(seg)-1].Ts.Before(start) || seg[0].Ts.After(end) {
			continue
		}
		if i > 0 && seg[0].Ts.After(start) && !seg[0].Ts.After(end) {
			res.Resets++ // restart marker falls inside the window
		}
		type pt struct {
			t time.Time
			v float64
		}
		pts := []pt{{start, valueAt(seg, start)}}
		for _, sm := range seg {
			if sm.Ts.After(start) && sm.Ts.Before(end) {
				pts = append(pts, pt{sm.Ts, sm.Value})
				res.Samples++
			}
		}
		pts = append(pts, pt{end, valueAt(seg, end)})
		for k := 1; k < len(pts); k++ {
			d := pts[k].v - pts[k-1].v
			switch {
			case d >= 0:
				res.Increase += d
			default:
				// Unmarked reset: unknown how much was counted during the
				// gap. Skip the negative delta, flag uncertainty.
				res.Uncertain = true
			}
		}
	}
	res.Rate = res.Increase / res.Duration.Seconds()
	return res, nil
}
