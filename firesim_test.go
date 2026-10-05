package firesim

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// row is a helper building a 1-row grid from state letters.
func row(s string) []uint8 {
	g := make([]uint8, len(s))
	for i, c := range s {
		switch c {
		case '.':
			g[i] = Empty
		case 'T':
			g[i] = Tree
		case 'F':
			g[i] = Burning
		case 'X':
			g[i] = Burnt
		}
	}
	return g
}

func gridString(s *Sim) string {
	var buf bytes.Buffer
	for y := 0; y < s.Height; y++ {
		for x := 0; x < s.Width; x++ {
			switch s.Cell(x, y) {
			case Empty:
				buf.WriteByte('.')
			case Tree:
				buf.WriteByte('T')
			case Burning:
				buf.WriteByte('F')
			case Burnt:
				buf.WriteByte('X')
			}
		}
		buf.WriteByte('\n')
	}
	return buf.String()
}

func TestSimultaneousUpdate(t *testing.T) {
	// Certain spread (1024/1024), no wind: fire advances exactly one
	// ring per round, proving updates are simultaneous.
	sim := NewSim(Config{
		Width: 7, Height: 1, Seed: 1,
		BaseProb: 1024,
		Grid:     row("TTTFTTT"),
	})
	sim.Step()
	if got, want := gridString(sim), "TTFXFTT\n"; got != want {
		t.Fatalf("after round 1: got %q want %q", got, want)
	}
	sim.Step()
	if got, want := gridString(sim), "TFXXXFT\n"; got != want {
		t.Fatalf("after round 2: got %q want %q", got, want)
	}
}

func TestExtinguishBeforePropagation(t *testing.T) {
	// The burning cell is extinguished at the start of round 0, before
	// propagation: it reverts to Tree and must not ignite its neighbour.
	sim := NewSim(Config{
		Width: 3, Height: 1, Seed: 1,
		BaseProb: 1024,
		Grid:     row("FTT"),
		Events:   []Event{{Round: 0, X: 0, Y: 0}},
	})
	sim.Step()
	if got, want := gridString(sim), "TTT\n"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if !sim.Finished() {
		t.Fatal("simulation should be finished: no burning cells")
	}
}

func TestExtinguishOnlyAppliesToScheduledRound(t *testing.T) {
	// Event targets round 1, but the cell only starts burning after
	// round 0; at round 1 it is extinguished before spreading further.
	sim := NewSim(Config{
		Width: 5, Height: 1, Seed: 1,
		BaseProb: 1024,
		Grid:     row("FTTTT"),
		Events:   []Event{{Round: 1, X: 1, Y: 0}},
	})
	sim.Step() // round 0: cell 1 ignites from cell 0
	if got, want := gridString(sim), "XFTTT\n"; got != want {
		t.Fatalf("after round 0: got %q want %q", got, want)
	}
	sim.Step() // round 1: cell 1 extinguished before it can ignite cell 2
	if got, want := gridString(sim), "XTTTT\n"; got != want {
		t.Fatalf("after round 1: got %q want %q", got, want)
	}
}

func TestWindSegments(t *testing.T) {
	// Base probability 0, wind boost certain: fire spreads only in the
	// current wind direction. Wind blows East for rounds 0-1, then West
	// from round 2 on.
	sim := NewSim(Config{
		Width: 7, Height: 1, Seed: 1,
		BaseProb: 0, WindBoost: 1024,
		Grid: row("TTTFTTT"),
		Wind: []WindSegment{
			{FromRound: 0, Dir: East},
			{FromRound: 2, Dir: West},
		},
	})
	sim.Step() // round 0, wind East: only the east neighbour ignites
	if got, want := gridString(sim), "TTTXFTT\n"; got != want {
		t.Fatalf("after round 0: got %q want %q", got, want)
	}
	sim.Step() // round 1, wind East: fire keeps moving east
	if got, want := gridString(sim), "TTTXXFT\n"; got != want {
		t.Fatalf("after round 1: got %q want %q", got, want)
	}
	sim.Step() // round 2, wind West: the upwind neighbour is already
	// Burnt, so the fire cannot spread back and dies out.
	if got, want := gridString(sim), "TTTXXXT\n"; got != want {
		t.Fatalf("after round 2: got %q want %q", got, want)
	}
	if !sim.Finished() {
		t.Fatal("simulation should be finished")
	}
}

func TestWindAt(t *testing.T) {
	sim := NewSim(Config{
		Width: 1, Height: 1, Seed: 1,
		Wind: []WindSegment{
			{FromRound: 5, Dir: South},
			{FromRound: 2, Dir: East},
			{FromRound: 9, Dir: North},
		},
	})
	cases := []struct {
		round int
		want  Direction
	}{
		{0, NoDir}, {1, NoDir}, {2, East}, {4, East},
		{5, South}, {8, South}, {9, North}, {100, North},
	}
	for _, c := range cases {
		if got := sim.windAt(c.round); got != c.want {
			t.Errorf("windAt(%d) = %v, want %v", c.round, got, c.want)
		}
	}
}

func TestDeterminismFromSeed(t *testing.T) {
	cfg := Config{
		Width: 16, Height: 16, Seed: 42,
		BaseProb: 300, WindBoost: 400,
		Ignite: []Point{{X: 8, Y: 8}},
		Wind:   []WindSegment{{FromRound: 0, Dir: East}},
	}
	a := NewSim(cfg)
	b := NewSim(cfg)
	for i := 0; i < 30; i++ {
		a.Step()
		b.Step()
	}
	if !bytes.Equal(a.Grid, b.Grid) {
		t.Fatal("same seed must reproduce identical grids")
	}
	cfg.Seed = 43
	d := NewSim(cfg)
	for i := 0; i < 30; i++ {
		d.Step()
	}
	if bytes.Equal(a.Grid, d.Grid) {
		t.Fatal("different seeds should diverge")
	}
}

func TestCheckpointRecordsSeedAndState(t *testing.T) {
	sim := NewSim(Config{
		Width: 8, Height: 8, Seed: 0xC0FFEE,
		BaseProb: 500,
		Ignite:   []Point{{X: 4, Y: 4}},
	})
	if _, err := sim.Run(3, ""); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "cp.json")
	if err := sim.SaveCheckpoint(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cp Checkpoint
	if err := json.Unmarshal(data, &cp); err != nil {
		t.Fatal(err)
	}
	if cp.Seed != 0xC0FFEE {
		t.Errorf("seed not recorded: got %#x", cp.Seed)
	}
	if cp.RngState == 0 {
		t.Error("rng state not recorded")
	}
	if cp.Round != 3 {
		t.Errorf("round = %d, want 3", cp.Round)
	}
	if len(cp.Grid) != 64 {
		t.Errorf("grid has %d cells, want 64", len(cp.Grid))
	}
}

func TestBudgetExhaustionSavesCheckpoint(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cp.json")
	sim := NewSim(Config{
		Width: 20, Height: 20, Seed: 7,
		BaseProb: 1024,
		Ignite:   []Point{{X: 10, Y: 10}},
	})
	res, err := sim.Run(0, path)
	if err != nil {
		t.Fatal(err)
	}
	if res.RoundsRun != 0 {
		t.Fatalf("budget 0 ran %d rounds", res.RoundsRun)
	}
	if !res.CheckpointSaved {
		t.Fatal("budget exhausted before finishing: checkpoint expected")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("checkpoint file missing: %v", err)
	}

	// A finished run must not save a checkpoint.
	path2 := filepath.Join(dir, "cp2.json")
	sim2 := NewSim(Config{Width: 2, Height: 1, Seed: 1, Grid: row("T.")})
	res2, err := sim2.Run(10, path2)
	if err != nil {
		t.Fatal(err)
	}
	if !res2.Finished || res2.CheckpointSaved {
		t.Fatalf("got %+v, want finished without checkpoint", res2)
	}
	if _, err := os.Stat(path2); !os.IsNotExist(err) {
		t.Fatal("no checkpoint should be written for a finished run")
	}
}

func TestSegmentedRunMatchesSingleRun(t *testing.T) {
	cfg := Config{
		Width: 14, Height: 14, Seed: 20261005,
		BaseProb: 250, WindBoost: 500,
		Ignite: []Point{{X: 3, Y: 3}, {X: 10, Y: 11}},
		Wind: []WindSegment{
			{FromRound: 0, Dir: East},
			{FromRound: 4, Dir: South},
			{FromRound: 9, Dir: West},
		},
		Events: []Event{
			{Round: 2, X: 4, Y: 3},
			{Round: 6, X: 10, Y: 12},
		},
	}

	// Single uninterrupted run, recording the grid after every round.
	single := NewSim(cfg)
	var history [][]uint8
	for !single.Finished() {
		single.Step()
		history = append(history, append([]uint8(nil), single.Grid...))
	}

	// Segmented run: budget 3 rounds per segment, checkpoint to disk
	// and restore between segments.
	dir := t.TempDir()
	path := filepath.Join(dir, "checkpoint.json")
	seg := NewSim(cfg)
	for {
		res, err := seg.Run(3, path)
		if err != nil {
			t.Fatal(err)
		}
		// The segmented run must match the single run cell for cell
		// at every segment boundary.
		if !bytes.Equal(seg.Grid, history[seg.Round-1]) {
			t.Fatalf("round %d: segmented grid differs from single run\nseg:\n%s\nsingle:\n%s",
				seg.Round, gridString(seg), gridString(single))
		}
		if res.Finished {
			break
		}
		if !res.CheckpointSaved {
			t.Fatal("budget exhausted but no checkpoint saved")
		}
		seg, err = LoadCheckpoint(path)
		if err != nil {
			t.Fatal(err)
		}
		if seg.Seed() != cfg.Seed {
			t.Fatal("restored sim lost its seed")
		}
	}
	if seg.Round != single.Round {
		t.Fatalf("segmented run took %d rounds, single run %d", seg.Round, single.Round)
	}
	if !bytes.Equal(seg.Grid, single.Grid) {
		t.Fatal("final grids differ between segmented and single run")
	}
}

func TestCheckpointRoundTripContinuesIdentically(t *testing.T) {
	cfg := Config{
		Width: 10, Height: 10, Seed: 99,
		BaseProb: 400, WindBoost: 300,
		Ignite: []Point{{X: 5, Y: 5}},
		Wind:   []WindSegment{{FromRound: 0, Dir: North}},
	}
	full := NewSim(cfg)
	if _, err := full.Run(50, ""); err != nil {
		t.Fatal(err)
	}

	part := NewSim(cfg)
	if _, err := part.Run(7, ""); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "cp.json")
	if err := part.SaveCheckpoint(path); err != nil {
		t.Fatal(err)
	}
	restored, err := LoadCheckpoint(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restored.Run(50, ""); err != nil {
		t.Fatal(err)
	}
	if restored.Round != full.Round {
		t.Fatalf("rounds differ: %d vs %d", restored.Round, full.Round)
	}
	if !bytes.Equal(restored.Grid, full.Grid) {
		t.Fatal("restored run diverged from uninterrupted run")
	}
}
