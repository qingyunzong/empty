package dataeng

import (
	"errors"
	"math"
	"sort"
	"time"
)

// Default parameter values applied by New when Config fields are zero.
const (
	DefaultWindow = 8
	DefaultBeta   = 50.0 // meters
)

var (
	// ErrTooLate is returned when an observation arrives later than the
	// configured watermark allows, or older than the committed prefix.
	ErrTooLate = errors.New("dataeng: observation beyond watermark or already committed")
	// ErrDuplicateTime is returned when an observation carries a timestamp
	// already present in the lattice.
	ErrDuplicateTime = errors.New("dataeng: duplicate observation timestamp")
	// ErrNoCandidates is returned when an observation has no candidates.
	ErrNoCandidates = errors.New("dataeng: observation has no candidates")
	// ErrBadSigma is returned when an observation has a non-positive sigma.
	ErrBadSigma = errors.New("dataeng: observation sigma must be positive")
)

// Candidate is one possible road match for an observation. Off is the
// distance from the raw position to the road, in meters.
type Candidate struct {
	RoadID string
	Off    float64
}

// Observation is a single position fix together with its candidate roads.
// X and Y are planar coordinates used only for the linear distance between
// consecutive fixes. Sigma is the observation error standard deviation in
// meters.
type Observation struct {
	Time  time.Time
	X, Y  float64
	Sigma float64
	Cands []Candidate
}

// DistFunc reports the route distance in meters between two candidates of
// consecutive observations. ok=false marks the transition as unreachable.
type DistFunc func(from, to Candidate) (route float64, ok bool)

// Config tunes a Matcher.
type Config struct {
	// Window bounds how many lattice columns are kept uncommitted. Once
	// the tail exceeds Window, the oldest columns are committed as the
	// stable prefix. Defaults to DefaultWindow.
	Window int
	// Watermark is the maximum lateness, relative to the newest
	// observation seen, at which a point may still revise the unstable
	// tail. Zero rejects all out-of-order points.
	Watermark time.Duration
	// Gap is the GPS gap threshold: a point arriving more than Gap after
	// the previous one closes the current segment and opens a new one.
	// Zero disables gap detection.
	Gap time.Duration
	// Beta is the scale, in meters, of the exponential transition model.
	// Defaults to DefaultBeta.
	Beta float64
}

// Match is one committed position fix assigned to a road.
type Match struct {
	Time    time.Time
	RoadID  string
	Segment int // 1-based; increments after each GPS gap
}

// Matcher is a streaming Viterbi map matcher with a bounded lattice
// window. It is not safe for concurrent use.
type Matcher struct {
	cfg  Config
	dist DistFunc

	cols  []column  // unstable tail, ordered by observation time
	seg   int       // current 1-based segment number
	lastT time.Time // newest observation time seen
	seenT bool
	commT time.Time // committed-through time
	seenC bool
}

type state struct {
	delta float64 // best log probability of any path ending here
	prev  int     // index into previous column's states, -1 if none
}

type column struct {
	obs    Observation
	cands  []Candidate // sorted by (RoadID, Off) for deterministic ties
	linear float64     // linear distance from previous column's observation
	states []state
}

// New returns a Matcher using cfg and the caller-supplied transition
// distance function.
func New(cfg Config, dist DistFunc) *Matcher {
	if cfg.Window <= 0 {
		cfg.Window = DefaultWindow
	}
	if cfg.Beta <= 0 {
		cfg.Beta = DefaultBeta
	}
	return &Matcher{cfg: cfg, dist: dist, seg: 1}
}

// Add feeds one observation. In-order points extend the tail; points
// arriving out of order but within the watermark are inserted into the
// unstable tail and trigger recomputation from the insertion point
// forward. Add returns any matches that became stable as a result, in
// time order.
func (m *Matcher) Add(obs Observation) ([]Match, error) {
	if len(obs.Cands) == 0 {
		return nil, ErrNoCandidates
	}
	if obs.Sigma <= 0 {
		return nil, ErrBadSigma
	}
	if m.seenT && !obs.Time.After(m.lastT) {
		return m.addLate(obs)
	}

	var out []Match
	if n := len(m.cols); n > 0 && m.cfg.Gap > 0 &&
		obs.Time.Sub(m.cols[n-1].obs.Time) > m.cfg.Gap {
		out = m.commitAll()
		m.seg++
	}
	m.cols = append(m.cols, newColumn(obs, m.linearToLast(obs)))
	m.recomputeFrom(len(m.cols) - 1)
	m.lastT, m.seenT = obs.Time, true
	return append(out, m.enforceWindow()...), nil
}

// addLate inserts an out-of-order observation into the unstable tail.
func (m *Matcher) addLate(obs Observation) ([]Match, error) {
	if m.seenC && !obs.Time.After(m.commT) {
		return nil, ErrTooLate
	}
	if m.lastT.Sub(obs.Time) > m.cfg.Watermark {
		return nil, ErrTooLate
	}
	pos := sort.Search(len(m.cols), func(i int) bool {
		return m.cols[i].obs.Time.After(obs.Time)
	})
	if pos < len(m.cols) && m.cols[pos].obs.Time.Equal(obs.Time) {
		return nil, ErrDuplicateTime
	}
	if pos > 0 && m.cols[pos-1].obs.Time.Equal(obs.Time) {
		return nil, ErrDuplicateTime
	}
	m.cols = append(m.cols, column{})
	copy(m.cols[pos+1:], m.cols[pos:])
	m.cols[pos] = newColumn(obs, 0)
	m.recomputeFrom(pos)
	return m.enforceWindow(), nil
}

// Flush commits the entire unstable tail and returns its matches. The
// Matcher remains usable; subsequent observations start a fresh lattice
// in the same segment unless a gap is detected.
func (m *Matcher) Flush() []Match {
	return m.commitAll()
}

// Tail returns the current best-path assignment of the unstable tail.
// These matches are provisional: late points within the watermark and
// future observations may still revise them.
func (m *Matcher) Tail() []Match {
	if len(m.cols) == 0 {
		return nil
	}
	path := m.trace()
	out := make([]Match, len(m.cols))
	for i := range m.cols {
		out[i] = Match{
			Time:    m.cols[i].obs.Time,
			RoadID:  m.cols[i].cands[path[i]].RoadID,
			Segment: m.seg,
		}
	}
	return out
}

// newColumn builds a column with emission-only scores; transition
// recomputation happens in recomputeFrom.
func newColumn(obs Observation, linear float64) column {
	cands := make([]Candidate, len(obs.Cands))
	copy(cands, obs.Cands)
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].RoadID != cands[j].RoadID {
			return cands[i].RoadID < cands[j].RoadID
		}
		return cands[i].Off < cands[j].Off
	})
	return column{
		obs:    obs,
		cands:  cands,
		linear: linear,
		states: make([]state, len(cands)),
	}
}

// emission is the log of the zero-mean Gaussian observation density.
func emission(off, sigma float64) float64 {
	z := off / sigma
	return -0.5*z*z - math.Log(sigma) - 0.5*math.Log(2*math.Pi)
}

// transition is the log of the exponential route-vs-linear distance
// density. Unreachable transitions yield -Inf.
func (m *Matcher) transition(from, to Candidate, linear float64) float64 {
	route, ok := m.dist(from, to)
	if !ok {
		return math.Inf(-1)
	}
	return -math.Abs(route-linear)/m.cfg.Beta - math.Log(m.cfg.Beta)
}

func (m *Matcher) linearToLast(obs Observation) float64 {
	if len(m.cols) == 0 {
		return 0
	}
	prev := m.cols[len(m.cols)-1].obs
	return math.Hypot(obs.X-prev.X, obs.Y-prev.Y)
}

// recomputeFrom recomputes linear distances and Viterbi scores for all
// columns from index pos to the end of the tail.
func (m *Matcher) recomputeFrom(pos int) {
	for i := pos; i < len(m.cols); i++ {
		c := &m.cols[i]
		if i == 0 {
			c.linear = 0
			for j := range c.states {
				c.states[j] = state{delta: emission(c.cands[j].Off, c.obs.Sigma), prev: -1}
			}
			continue
		}
		prev := &m.cols[i-1]
		c.linear = math.Hypot(c.obs.X-prev.obs.X, c.obs.Y-prev.obs.Y)
		for j, cand := range c.cands {
			best, arg := math.Inf(-1), 0
			for k, ps := range prev.states {
				score := ps.delta + m.transition(prev.cands[k], cand, c.linear)
				// Strictly greater keeps the earliest (lexicographically
				// smallest RoadID) predecessor on ties.
				if score > best {
					best, arg = score, k
				}
			}
			c.states[j] = state{
				delta: best + emission(cand.Off, c.obs.Sigma),
				prev:  arg,
			}
		}
	}
}

// bestFinal returns the index of the best state in the last column.
// Ties resolve to the earliest candidate, the smallest RoadID.
func bestFinal(c *column) int {
	best, arg := math.Inf(-1), 0
	for j, s := range c.states {
		if s.delta > best {
			best, arg = s.delta, j
		}
	}
	return arg
}

// trace follows backpointers from the best final state to column 0 and
// returns the chosen candidate index for every column.
func (m *Matcher) trace() []int {
	path := make([]int, len(m.cols))
	idx := bestFinal(&m.cols[len(m.cols)-1])
	path[len(m.cols)-1] = idx
	for i := len(m.cols) - 1; i > 0; i-- {
		idx = m.cols[i].states[idx].prev
		path[i-1] = idx
	}
	return path
}

// enforceWindow commits the oldest columns until the tail fits the
// configured window, returning the committed matches in time order.
func (m *Matcher) enforceWindow() []Match {
	var out []Match
	for len(m.cols) > m.cfg.Window {
		out = append(out, m.commitOldest())
	}
	return out
}

// commitOldest commits column 0 along the best final path and drops it
// from the tail. Backpointers of the surviving columns are unaffected:
// tracing never reads past the new column 0.
func (m *Matcher) commitOldest() Match {
	path := m.trace()
	mt := Match{
		Time:    m.cols[0].obs.Time,
		RoadID:  m.cols[0].cands[path[0]].RoadID,
		Segment: m.seg,
	}
	m.cols = m.cols[1:]
	m.commT, m.seenC = mt.Time, true
	return mt
}

// commitAll commits every column in the tail along the best final path.
func (m *Matcher) commitAll() []Match {
	if len(m.cols) == 0 {
		return nil
	}
	out := make([]Match, 0, len(m.cols))
	for len(m.cols) > 0 {
		out = append(out, m.commitOldest())
	}
	return out
}
