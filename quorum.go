// Package quorum simulates quorum-based commits across a joint
// reconfiguration from an old configuration to a new one.
//
// The protocol has three phases:
//
//	OldOnly: commits require a strict majority of the old config's weight.
//	Joint:   commits require a strict majority of BOTH configs' weight.
//	NewOnly: commits require a strict majority of the new config's weight.
//
// The switch OldOnly -> Joint -> NewOnly is only allowed in that order, and
// entering NewOnly requires a completed joint commit. Because every node
// casts at most one vote, two commits can carry different values only if
// their quorums are disjoint; the joint phase guarantees that concurrently
// live quorums always intersect.
package quorum

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Node identifies a voter.
type Node string

// Config is a weighted set of voters.
type Config struct {
	weights map[Node]int
	total   int
}

// NewConfig builds a Config. Every weight must be positive.
func NewConfig(weights map[Node]int) (Config, error) {
	if len(weights) == 0 {
		return Config{}, errors.New("quorum: empty configuration")
	}
	w := make(map[Node]int, len(weights))
	total := 0
	for n, wt := range weights {
		if wt <= 0 {
			return Config{}, fmt.Errorf("quorum: node %q has non-positive weight %d", n, wt)
		}
		w[n] = wt
		total += wt
	}
	return Config{weights: w, total: total}, nil
}

// Total returns the sum of all weights in the config.
func (c Config) Total() int { return c.total }

// Majority returns the smallest weight that is a strict majority of Total.
func (c Config) Majority() int { return c.total/2 + 1 }

// Weight reports the weight of n and whether n is a member.
func (c Config) Weight(n Node) (int, bool) {
	w, ok := c.weights[n]
	return w, ok
}

// Nodes returns the members in sorted order.
func (c Config) Nodes() []Node {
	ns := make([]Node, 0, len(c.weights))
	for n := range c.weights {
		ns = append(ns, n)
	}
	sort.Slice(ns, func(i, j int) bool { return ns[i] < ns[j] })
	return ns
}

// IsQuorum reports whether voters hold a strict majority of the total
// weight: sum(weights) * 2 > Total(). Unknown or duplicate voters are
// rejected.
func (c Config) IsQuorum(voters []Node) (bool, error) {
	seen := make(map[Node]bool, len(voters))
	sum := 0
	for _, n := range voters {
		w, ok := c.weights[n]
		if !ok {
			return false, fmt.Errorf("quorum: unknown node %q", n)
		}
		if seen[n] {
			return false, fmt.Errorf("quorum: duplicate vote from %q", n)
		}
		seen[n] = true
		sum += w
	}
	return 2*sum > c.total, nil
}

// hasQuorum is IsQuorum without validation: non-members and duplicates are
// ignored.
func (c Config) hasQuorum(voters []Node) bool {
	seen := make(map[Node]bool, len(voters))
	sum := 0
	for _, n := range voters {
		if seen[n] {
			continue
		}
		seen[n] = true
		if w, ok := c.weights[n]; ok {
			sum += w
		}
	}
	return 2*sum > c.total
}

// quorumEvidence builds the per-config evidence for voters, keeping only
// members of c.
func (c Config) quorumEvidence(voters []Node) ConfigEvidence {
	seen := make(map[Node]bool, len(voters))
	var members []Node
	sum := 0
	for _, n := range voters {
		if seen[n] {
			continue
		}
		seen[n] = true
		w, ok := c.weights[n]
		if !ok {
			continue
		}
		members = append(members, n)
		sum += w
	}
	sort.Slice(members, func(i, j int) bool { return members[i] < members[j] })
	return ConfigEvidence{
		Voters:    members,
		Weight:    sum,
		Total:     c.total,
		Threshold: c.Majority(),
	}
}

// Phase is the stage of the reconfiguration protocol.
type Phase int

const (
	// OldOnly: commits need a strict majority of the old config.
	OldOnly Phase = iota
	// Joint: commits need a strict majority of each config.
	Joint
	// NewOnly: commits need a strict majority of the new config.
	NewOnly
)

func (p Phase) String() string {
	switch p {
	case OldOnly:
		return "old-only"
	case Joint:
		return "joint"
	case NewOnly:
		return "new-only"
	}
	return "unknown"
}

// Satisfies reports whether voters meet the commit rule for phase: OldOnly
// needs a strict majority of the old config's weight, NewOnly of the new
// config's, and Joint needs both. Votes from non-members of a config are
// ignored for that config.
func Satisfies(phase Phase, oldCfg, newCfg Config, voters []Node) bool {
	if phase != NewOnly && !oldCfg.hasQuorum(voters) {
		return false
	}
	if phase != OldOnly && !newCfg.hasQuorum(voters) {
		return false
	}
	return true
}

// ConfigEvidence records how one config voted in a commit.
type ConfigEvidence struct {
	Voters    []Node // members whose votes counted
	Weight    int    // sum of voter weights
	Total     int    // total weight of the config
	Threshold int    // minimum weight for a strict majority
}

func (e ConfigEvidence) String() string {
	return fmt.Sprintf("voters=%v weight=%d total=%d need>=%d",
		e.Voters, e.Weight, e.Total, e.Threshold)
}

// Evidence is the voting record of a single commit.
type Evidence struct {
	Value string
	Phase Phase
	Old   *ConfigEvidence // non-nil when the old config voted
	New   *ConfigEvidence // non-nil when the new config voted
}

func (e Evidence) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "commit value=%q phase=%s", e.Value, e.Phase)
	if e.Old != nil {
		fmt.Fprintf(&b, " old{%s}", e.Old)
	}
	if e.New != nil {
		fmt.Fprintf(&b, " new{%s}", e.New)
	}
	return b.String()
}

// Simulator drives a cluster through the joint reconfiguration protocol
// OldOnly -> Joint -> NewOnly within a single ballot: every node casts at
// most one vote for the whole run.
type Simulator struct {
	oldCfg Config
	newCfg Config
	phase  Phase

	votes       map[Node]string
	commits     []Evidence
	jointCommit bool
}

// NewSimulator starts a simulation in the OldOnly phase.
func NewSimulator(oldCfg, newCfg Config) *Simulator {
	return &Simulator{
		oldCfg: oldCfg,
		newCfg: newCfg,
		phase:  OldOnly,
		votes:  make(map[Node]string),
	}
}

// Phase returns the current phase.
func (s *Simulator) Phase() Phase { return s.phase }

// Vote records node's vote for value. A node may vote at most once and must
// belong to the old or the new config.
func (s *Simulator) Vote(n Node, value string) error {
	if _, ok := s.oldCfg.Weight(n); !ok {
		if _, ok := s.newCfg.Weight(n); !ok {
			return fmt.Errorf("quorum: unknown node %q", n)
		}
	}
	if prev, ok := s.votes[n]; ok {
		return fmt.Errorf("quorum: node %q already voted for %q", n, prev)
	}
	s.votes[n] = value
	return nil
}

// EnterJoint moves from OldOnly into the joint phase.
func (s *Simulator) EnterJoint() error {
	if s.phase != OldOnly {
		return fmt.Errorf("quorum: cannot enter joint phase from %s", s.phase)
	}
	s.phase = Joint
	return nil
}

// EnterNew completes the switch to the new config. It requires a commit in
// the joint phase, so old-only and new-only quorums are never live at the
// same time.
func (s *Simulator) EnterNew() error {
	if s.phase != Joint {
		return fmt.Errorf("quorum: cannot enter new-only phase from %s", s.phase)
	}
	if !s.jointCommit {
		return errors.New("quorum: joint phase has no commit yet")
	}
	s.phase = NewOnly
	return nil
}

// Commit attempts to commit value under the current phase's rule. On success
// it appends the voting evidence to the commit log and returns it.
func (s *Simulator) Commit(value string) (Evidence, bool) {
	var voters []Node
	for n, v := range s.votes {
		if v == value {
			voters = append(voters, n)
		}
	}
	if !Satisfies(s.phase, s.oldCfg, s.newCfg, voters) {
		return Evidence{}, false
	}
	ev := Evidence{Value: value, Phase: s.phase}
	if s.phase != NewOnly {
		ce := s.oldCfg.quorumEvidence(voters)
		ev.Old = &ce
	}
	if s.phase != OldOnly {
		ce := s.newCfg.quorumEvidence(voters)
		ev.New = &ce
	}
	s.commits = append(s.commits, ev)
	if s.phase == Joint {
		s.jointCommit = true
	}
	return ev, true
}

// Commits returns the commit log.
func (s *Simulator) Commits() []Evidence {
	return append([]Evidence(nil), s.commits...)
}

// Conflicts reports all pairs of commits that carry different values.
func Conflicts(commits []Evidence) [][2]Evidence {
	var out [][2]Evidence
	for i := 0; i < len(commits); i++ {
		for j := i + 1; j < len(commits); j++ {
			if commits[i].Value != commits[j].Value {
				out = append(out, [2]Evidence{commits[i], commits[j]})
			}
		}
	}
	return out
}
