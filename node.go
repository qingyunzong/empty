package jointsim

// Entry is a replicated log entry. Cfg is non-nil for config entries:
// a joint config entry starts the joint phase, a simple config entry
// finalizes it.
type Entry struct {
	Index int
	Term  int
	Cmd   string
	Cfg   *Config
}

func (e Entry) isConfig() bool { return e.Cfg != nil }

type Node struct {
	ID     string
	Log    []Entry
	Commit int
}

func (n *Node) lastIndex() int { return len(n.Log) }

func (n *Node) at(i int) Entry { return n.Log[i-1] }

// appendEntries applies entries that start right after prevIndex. It is
// idempotent: entries already present with the same term are kept, and
// only genuinely conflicting suffixes are truncated and rewritten.
func (n *Node) appendEntries(prevIndex int, entries []Entry) (match int, ok bool) {
	if prevIndex > n.lastIndex() {
		return n.lastIndex(), false
	}
	for _, e := range entries {
		if e.Index <= n.lastIndex() {
			if n.at(e.Index).Term == e.Term {
				continue
			}
			n.Log = n.Log[:e.Index-1]
		}
		n.Log = append(n.Log, e)
	}
	return n.lastIndex(), true
}
