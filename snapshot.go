package tanksim

import "math/big"

// Snapshot is a complete, JSON-serializable copy of a simulation state.
// Rational values are encoded exactly (e.g. "2/3") via big.Rat text
// marshaling. Restoring a snapshot and continuing produces exactly the
// same events and levels as running the original simulation through.
type Snapshot struct {
	Time     *big.Rat  `json:"time"`
	Started  bool      `json:"started"`
	Tanks    []Tank    `json:"tanks"`
	Valves   []Valve   `json:"valves"`
	Triggers []Trigger `json:"triggers"`
	Events   []Event   `json:"events"`
}

// Snapshot captures the full simulation state, including the event log.
func (s *Sim) Snapshot() *Snapshot {
	snap := &Snapshot{
		Time:     cloneRat(s.time),
		Started:  s.started,
		Tanks:    make([]Tank, len(s.tanks)),
		Valves:   make([]Valve, len(s.valves)),
		Triggers: make([]Trigger, len(s.triggers)),
		Events:   make([]Event, len(s.events)),
	}
	for i, tk := range s.tanks {
		snap.Tanks[i] = Tank{ID: tk.ID, Capacity: cloneRat(tk.Capacity), Level: cloneRat(tk.Level)}
	}
	for i, v := range s.valves {
		snap.Valves[i] = Valve{ID: v.ID, From: v.From, To: v.To, Rate: cloneRat(v.Rate), Open: v.Open}
	}
	for i, tr := range s.triggers {
		cp := *tr
		if tr.Threshold != nil {
			cp.Threshold = cloneRat(tr.Threshold)
		}
		snap.Triggers[i] = cp
	}
	for i, ev := range s.events {
		snap.Events[i] = Event{
			Time:   cloneRat(ev.Time),
			Iter:   ev.Iter,
			Fired:  append([]string(nil), ev.Fired...),
			Levels: cloneLevels(ev.Levels),
			Valves: cloneValves(ev.Valves),
		}
	}
	return snap
}

// Restore rebuilds a simulation from a snapshot. The snapshot is deep-copied,
// so it can be reused to fork multiple replays.
func Restore(snap *Snapshot) (*Sim, error) {
	s, err := NewSim(snap.Tanks, snap.Valves, snap.Triggers)
	if err != nil {
		return nil, err
	}
	s.time = cloneRat(snap.Time)
	s.started = snap.Started
	s.events = make([]Event, len(snap.Events))
	for i, ev := range snap.Events {
		s.events[i] = Event{
			Time:   cloneRat(ev.Time),
			Iter:   ev.Iter,
			Fired:  append([]string(nil), ev.Fired...),
			Levels: cloneLevels(ev.Levels),
			Valves: cloneValves(ev.Valves),
		}
	}
	return s, nil
}

func cloneLevels(m map[string]*big.Rat) map[string]*big.Rat {
	out := make(map[string]*big.Rat, len(m))
	for k, v := range m {
		out[k] = cloneRat(v)
	}
	return out
}

func cloneValves(m map[string]bool) map[string]bool {
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
