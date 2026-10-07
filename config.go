package jointsim

import (
	"fmt"
	"sort"
	"strings"
)

// Config describes the cluster membership. While New is non-empty the
// cluster is in the joint phase and every commit requires a majority of
// both Old and New.
type Config struct {
	Old map[string]bool
	New map[string]bool
}

func SimpleConfig(members []string) Config {
	return Config{Old: toSet(members)}
}

func JointConfig(oldMembers, newMembers []string) Config {
	return Config{Old: toSet(oldMembers), New: toSet(newMembers)}
}

func (c Config) IsJoint() bool { return len(c.New) > 0 }

func majority(n int) int { return n/2 + 1 }

func (c Config) Members() map[string]bool {
	m := make(map[string]bool, len(c.Old)+len(c.New))
	for v := range c.Old {
		m[v] = true
	}
	for v := range c.New {
		m[v] = true
	}
	return m
}

func (c Config) OldQuorum(voters map[string]bool) bool {
	return countIn(voters, c.Old) >= majority(len(c.Old))
}

func (c Config) NewQuorum(voters map[string]bool) bool {
	return !c.IsJoint() || countIn(voters, c.New) >= majority(len(c.New))
}

// Quorum reports whether voters satisfy the commit rule of c: a majority
// of Old, and additionally a majority of New while joint.
func (c Config) Quorum(voters map[string]bool) bool {
	return c.OldQuorum(voters) && c.NewQuorum(voters)
}

func (c Config) String() string {
	if c.IsJoint() {
		return fmt.Sprintf("joint(old=%v,new=%v)", sortedKeys(c.Old), sortedKeys(c.New))
	}
	return fmt.Sprintf("simple%v", sortedKeys(c.Old))
}

// Certificate is the quorum certificate emitted for every committed
// entry. It names the governing config and the config members whose
// stored copy of the entry formed the quorum.
type Certificate struct {
	Index  int
	Term   int
	Config Config
	Voters []string
}

func (c *Certificate) Verify() error {
	if c == nil {
		return fmt.Errorf("nil certificate")
	}
	voters := toSet(c.Voters)
	members := c.Config.Members()
	for v := range voters {
		if !members[v] {
			return fmt.Errorf("voter %q is not a config member", v)
		}
	}
	if !c.Config.OldQuorum(voters) {
		return fmt.Errorf("no majority of old config %v", sortedKeys(c.Config.Old))
	}
	if c.Config.IsJoint() && !c.Config.NewQuorum(voters) {
		return fmt.Errorf("no majority of new config %v", sortedKeys(c.Config.New))
	}
	return nil
}

func (c *Certificate) String() string {
	voters := toSet(c.Voters)
	var b strings.Builder
	fmt.Fprintf(&b, "commit#%d term=%d cfg=%s old-voters=%v",
		c.Index, c.Term, c.Config, intersectSorted(voters, c.Config.Old))
	if c.Config.IsJoint() {
		fmt.Fprintf(&b, " new-voters=%v", intersectSorted(voters, c.Config.New))
	}
	return b.String()
}

func toSet(members []string) map[string]bool {
	s := make(map[string]bool, len(members))
	for _, m := range members {
		s[m] = true
	}
	return s
}

func countIn(voters, members map[string]bool) int {
	n := 0
	for v := range voters {
		if members[v] {
			n++
		}
	}
	return n
}

func sortedKeys(s map[string]bool) []string {
	out := make([]string, 0, len(s))
	for k := range s {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func intersectSorted(a, b map[string]bool) []string {
	var out []string
	for k := range a {
		if b[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
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
