// Package firesim implements a finite-grid fire propagation simulation.
//
// The simulation advances in discrete rounds. All cells update
// simultaneously from the state of the previous round, using public
// integer-only rules (no floating point):
//
//   - A Burning cell becomes Burnt.
//   - A Burnt or Empty cell stays unchanged.
//   - A Tree cell ignites if at least one of its 4 von Neumann
//     neighbours is Burning. For each burning neighbour in direction d
//     a threshold t = BaseProb is used, increased by WindBoost when the
//     neighbour lies upwind, i.e. d is opposite to the current wind
//     direction (wind pushes the fire downwind). Ignition happens when
//     rng.next() & 1023 < t (probabilities are per-1024 integers).
//
// The wind direction is piecewise constant: WindSegment entries take
// effect from their FromRound onward, the latest matching segment wins.
//
// Extinguish events scheduled for round r are applied at the start of
// round r, before that round's propagation: an extinguished Burning
// cell reverts to Tree and therefore does not ignite its neighbours in
// that round.
//
// The PRNG is a splitmix64 generator whose 64-bit state is fully
// recorded, together with the original seed, in every checkpoint.
package firesim

// Cell states.
const (
	Empty   uint8 = 0
	Tree    uint8 = 1
	Burning uint8 = 2
	Burnt   uint8 = 3
)

// Direction indexes the 4 von Neumann neighbours.
type Direction int

const (
	NoDir Direction = iota - 1
	North
	East
	South
	West
)

var dirDelta = [4][2]int{
	North: {0, -1},
	East:  {1, 0},
	South: {0, 1},
	West:  {-1, 0},
}

// opposite returns the reverse direction; NoDir maps to NoDir.
func opposite(d Direction) Direction {
	switch d {
	case North:
		return South
	case South:
		return North
	case East:
		return West
	case West:
		return East
	}
	return NoDir
}

// Point is a grid coordinate.
type Point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// WindSegment sets the wind direction starting at FromRound (inclusive).
type WindSegment struct {
	FromRound int       `json:"from_round"`
	Dir       Direction `json:"dir"`
}

// Event extinguishes the burning cell at (X, Y) at the start of Round,
// before that round's propagation step.
type Event struct {
	Round int `json:"round"`
	X     int `json:"x"`
	Y     int `json:"y"`
}

// Config describes a new simulation. Probabilities are per-1024.
type Config struct {
	Width     int
	Height    int
	Seed      uint64
	BaseProb  int // ignition probability per burning neighbour, 0..1024
	WindBoost int // extra probability for the downwind neighbour, 0..1024

	// Grid is the optional initial grid (row-major, Width*Height).
	// If nil, the grid starts as all Tree cells.
	Grid []uint8
	// Ignite lists cells set to Burning on top of the initial grid.
	Ignite []Point

	Wind   []WindSegment
	Events []Event
}

// splitmix64 PRNG: fully serialisable through its 64-bit state.
type rng struct {
	state uint64
}

func (r *rng) next() uint64 {
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Sim is a fire propagation simulation.
type Sim struct {
	Width  int
	Height int
	Round  int
	Grid   []uint8

	seed      uint64
	rng       rng
	baseProb  int
	windBoost int
	wind      []WindSegment
	events    []Event
}

// NewSim builds a simulation from cfg. Out-of-range Ignite points are
// ignored.
func NewSim(cfg Config) *Sim {
	grid := make([]uint8, cfg.Width*cfg.Height)
	if cfg.Grid != nil {
		copy(grid, cfg.Grid)
	} else {
		for i := range grid {
			grid[i] = Tree
		}
	}
	for _, p := range cfg.Ignite {
		if p.X >= 0 && p.X < cfg.Width && p.Y >= 0 && p.Y < cfg.Height {
			grid[p.Y*cfg.Width+p.X] = Burning
		}
	}
	return &Sim{
		Width:     cfg.Width,
		Height:    cfg.Height,
		Grid:      grid,
		seed:      cfg.Seed,
		rng:       rng{state: cfg.Seed},
		baseProb:  cfg.BaseProb,
		windBoost: cfg.WindBoost,
		wind:      append([]WindSegment(nil), cfg.Wind...),
		events:    append([]Event(nil), cfg.Events...),
	}
}

// Seed returns the seed the simulation was created or restored with.
func (s *Sim) Seed() uint64 { return s.seed }

// Cell returns the state of cell (x, y).
func (s *Sim) Cell(x, y int) uint8 { return s.Grid[y*s.Width+x] }

// Finished reports whether no Burning cells remain.
func (s *Sim) Finished() bool {
	for _, c := range s.Grid {
		if c == Burning {
			return false
		}
	}
	return true
}

// windAt returns the wind direction active in the given round.
func (s *Sim) windAt(round int) Direction {
	dir := NoDir
	best := -1
	for _, seg := range s.wind {
		if seg.FromRound <= round && seg.FromRound >= best {
			best = seg.FromRound
			dir = seg.Dir
		}
	}
	return dir
}

// applyEvents extinguishes the burning cells scheduled for the current
// round. It runs before propagation, so extinguished cells neither burn
// out nor ignite neighbours this round.
func (s *Sim) applyEvents() {
	for _, e := range s.events {
		if e.Round != s.Round {
			continue
		}
		if e.X < 0 || e.X >= s.Width || e.Y < 0 || e.Y >= s.Height {
			continue
		}
		idx := e.Y*s.Width + e.X
		if s.Grid[idx] == Burning {
			s.Grid[idx] = Tree
		}
	}
}

// ignites reports whether the Tree cell at (x, y) catches fire this
// round. Neighbours are probed in the fixed order North, East, South,
// West, drawing one random number per burning neighbour until ignition.
func (s *Sim) ignites(x, y int, wind Direction) bool {
	for d := North; d <= West; d++ {
		nx, ny := x+dirDelta[d][0], y+dirDelta[d][1]
		if nx < 0 || nx >= s.Width || ny < 0 || ny >= s.Height {
			continue
		}
		if s.Grid[ny*s.Width+nx] != Burning {
			continue
		}
		threshold := s.baseProb
		if d == opposite(wind) {
			threshold += s.windBoost
		}
		if threshold > 0 && s.rng.next()&1023 < uint64(threshold) {
			return true
		}
	}
	return false
}

// Step advances the simulation by one round: extinguish events first,
// then a simultaneous propagation update of every cell.
func (s *Sim) Step() {
	s.applyEvents()
	next := make([]uint8, len(s.Grid))
	wind := s.windAt(s.Round)
	for y := 0; y < s.Height; y++ {
		for x := 0; x < s.Width; x++ {
			idx := y*s.Width + x
			switch s.Grid[idx] {
			case Burning:
				next[idx] = Burnt
			case Tree:
				if s.ignites(x, y, wind) {
					next[idx] = Burning
				} else {
					next[idx] = Tree
				}
			default:
				next[idx] = s.Grid[idx]
			}
		}
	}
	s.Grid = next
	s.Round++
}

// RunResult summarises a Run call.
type RunResult struct {
	Finished        bool // no Burning cells remain
	RoundsRun       int  // rounds advanced by this call
	CheckpointSaved bool // a continuation point was written
}

// Run advances the simulation by at most budget rounds. If the budget
// is exhausted before the fire dies out and checkpointPath is
// non-empty, the full state (seed, RNG state, round, grid, schedule,
// events) is saved so the run can be resumed later with
// LoadCheckpoint.
func (s *Sim) Run(budget int, checkpointPath string) (RunResult, error) {
	var res RunResult
	for res.RoundsRun < budget && !s.Finished() {
		s.Step()
		res.RoundsRun++
	}
	res.Finished = s.Finished()
	if !res.Finished && checkpointPath != "" {
		if err := s.SaveCheckpoint(checkpointPath); err != nil {
			return res, err
		}
		res.CheckpointSaved = true
	}
	return res, nil
}
