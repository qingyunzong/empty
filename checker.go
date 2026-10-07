package jointsim

import "fmt"

// CheckTrace validates a simulator trace against the joint-consensus
// safety rules:
//
//   - every commit carries a valid quorum certificate;
//   - before the final config is committed, every certificate still
//     covers the last stable config, so an uncommitted new set can never
//     advance on its own;
//   - after the final config is committed, commits use the new set only;
//   - the joint config is committed before the final config, and
//     membership changes never overlap.
func CheckTrace(trace []Event, initial []string) error {
	stable := sortedCopy(initial)
	var joint *Config
	var target []string
	jointCommitted := false
	finalDone := false
	lastCommit := 0
	for i, ev := range trace {
		switch ev.Kind {
		case EvConfigPropose:
			if joint != nil {
				return fmt.Errorf("event %d: overlapping membership changes", i)
			}
			joint = ev.Joint
			target = ev.Target
			jointCommitted = false
			finalDone = false
		case EvCommit:
			c := ev.Cert
			if c == nil {
				return fmt.Errorf("event %d: commit without quorum certificate", i)
			}
			if c.Index <= lastCommit {
				return fmt.Errorf("event %d: commit index %d does not advance", i, c.Index)
			}
			lastCommit = c.Index
			if err := c.Verify(); err != nil {
				return fmt.Errorf("event %d: invalid certificate: %v", i, err)
			}
			if finalDone {
				if c.Config.IsJoint() || !equalMembers(target, c.Config.Old) {
					return fmt.Errorf("event %d: after the final config, commits must use the new set only", i)
				}
				continue
			}
			if !equalMembers(stable, c.Config.Old) {
				return fmt.Errorf("event %d: certificate does not cover stable config %v", i, stable)
			}
			if countIn(toSet(c.Voters), toSet(stable)) < majority(len(stable)) {
				return fmt.Errorf("event %d: commit without majority of stable config %v: uncommitted new set advanced alone", i, stable)
			}
		case EvConfigCommit:
			if joint == nil {
				return fmt.Errorf("event %d: joint config committed but none proposed", i)
			}
			jointCommitted = true
		case EvConfigFinal:
			if !jointCommitted {
				return fmt.Errorf("event %d: final config committed before the joint config", i)
			}
			finalDone = true
			stable = target
			joint = nil
		}
	}
	return nil
}

func equalMembers(members []string, set map[string]bool) bool {
	if len(members) != len(set) {
		return false
	}
	for _, m := range members {
		if !set[m] {
			return false
		}
	}
	return true
}

// Certificates returns the commit quorum certificates recorded in a trace.
func Certificates(trace []Event) []*Certificate {
	var out []*Certificate
	for _, ev := range trace {
		if ev.Kind == EvCommit {
			out = append(out, ev.Cert)
		}
	}
	return out
}
