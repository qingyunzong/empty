package arb

import (
	"fmt"
	"sort"
	"strings"
)

// CommitEvidence is the voting proof for one committed entry.
type CommitEvidence struct {
	Index   int
	Value   string
	Phase   Phase
	Tallies []Tally // one per configuration that had to approve
}

// String renders the evidence, e.g. for audit output.
func (e CommitEvidence) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "commit idx=%d value=%q phase=%s", e.Index, e.Value, e.Phase)
	for _, t := range e.Tallies {
		fmt.Fprintf(&b, " | yes=%v weight=%d/%d need=%d pass=%t",
			t.Voters, t.YesWeight, t.TotalWeight, t.Need, t.Pass)
	}
	return b.String()
}

// Node is a simulated voter. A node votes for at most one value per log
// index; this is the voter discipline the safety argument relies on.
type Node struct {
	ID       string
	votedFor map[int]string
}

// Cluster simulates one logical log arbitrated by a changing config.
type Cluster struct {
	phase Phase
	old   Config
	new   Config // valid once the joint phase has been entered

	nodes  map[string]*Node
	commit map[int]string // index -> committed value

	// Evidence holds the voting proof of every commit, in order.
	Evidence []CommitEvidence
	// Violations records conflicting commits; it must stay empty.
	Violations []string
}

// NewCluster starts a cluster governed solely by the old config.
func NewCluster(old Config) *Cluster {
	nodes := map[string]*Node{}
	for id := range old.Weights {
		nodes[id] = &Node{ID: id, votedFor: map[int]string{}}
	}
	return &Cluster{
		phase:  PhaseOld,
		old:    old,
		nodes:  nodes,
		commit: map[int]string{},
	}
}

// Phase reports the current phase.
func (c *Cluster) Phase() Phase { return c.phase }

// collectVotes asks each wanted voter to vote for value at index.
// Unknown voters are ignored; a node that already voted for a
// different value at this index votes no.
func (c *Cluster) collectVotes(index int, value string, wanted []string) []string {
	var yes []string
	for _, id := range wanted {
		n, ok := c.nodes[id]
		if !ok {
			continue
		}
		if prev, voted := n.votedFor[index]; voted && prev != value {
			continue
		}
		n.votedFor[index] = value
		yes = append(yes, id)
	}
	sort.Strings(yes)
	return yes
}

// requiredConfigs returns the configs that must each approve a commit
// in the current phase.
func (c *Cluster) requiredConfigs() []Config {
	switch c.phase {
	case PhaseJoint:
		return []Config{c.old, c.new}
	case PhaseNew:
		return []Config{c.new}
	default:
		return []Config{c.old}
	}
}

// propose collects votes and commits if every required config reaches
// its strict weighted majority. It returns the evidence on commit.
func (c *Cluster) propose(index int, value string, wanted []string) (*CommitEvidence, bool) {
	yes := c.collectVotes(index, value, wanted)
	ev := CommitEvidence{Index: index, Value: value, Phase: c.phase}
	committed := true
	for _, cfg := range c.requiredConfigs() {
		t := cfg.CountVotes(yes)
		ev.Tallies = append(ev.Tallies, t)
		if !t.Pass {
			committed = false
		}
	}
	if !committed {
		return nil, false
	}
	if prev, ok := c.commit[index]; ok && prev != value {
		c.Violations = append(c.Violations,
			fmt.Sprintf("conflicting commits at index %d: %q and %q", index, prev, value))
		return nil, false
	}
	c.commit[index] = value
	c.Evidence = append(c.Evidence, ev)
	return &ev, true
}

// Propose offers value at index to the given voters under the rules of
// the current phase.
func (c *Cluster) Propose(index int, value string, voters []string) (*CommitEvidence, bool) {
	return c.propose(index, value, voters)
}

// EnterJoint proposes the joint-configuration entry. It is committed
// under the old config's rules; once committed the cluster is in the
// joint phase and every later commit needs a majority of EACH config.
func (c *Cluster) EnterJoint(index int, newCfg Config, voters []string) (*CommitEvidence, bool) {
	if c.phase != PhaseOld {
		return nil, false
	}
	ev, ok := c.propose(index, "joint:"+configKey(newCfg), voters)
	if !ok {
		return nil, false
	}
	for id := range newCfg.Weights {
		if _, ok := c.nodes[id]; !ok {
			c.nodes[id] = &Node{ID: id, votedFor: map[int]string{}}
		}
	}
	c.new = newCfg
	c.phase = PhaseJoint
	return ev, true
}

// LeaveJoint proposes the new-config entry. It is committed under the
// joint rules (majority of old AND of new); once committed the switch
// is complete and only the new config decides.
func (c *Cluster) LeaveJoint(index int, voters []string) (*CommitEvidence, bool) {
	if c.phase != PhaseJoint {
		return nil, false
	}
	ev, ok := c.propose(index, "switch:"+configKey(c.new), voters)
	if !ok {
		return nil, false
	}
	c.phase = PhaseNew
	return ev, true
}

func configKey(c Config) string {
	ids := make([]string, 0, len(c.Weights))
	for id := range c.Weights {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var b strings.Builder
	for _, id := range ids {
		fmt.Fprintf(&b, "%s=%d;", id, c.Weights[id])
	}
	return b.String()
}
