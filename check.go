package linearchk

import (
	"fmt"
	"strings"
)

// Violation is one rule breach together with the command path that
// reaches it. Path entries are commands in source form; "[then]" and
// "[else]" mark branch entries.
type Violation struct {
	Path   []string
	Reason string
}

func (v Violation) String() string {
	return fmt.Sprintf("%s\n  path: %s", v.Reason, strings.Join(v.Path, " -> "))
}

// stepPure applies one non-branch command. On a rule breach it returns
// a reason and the unchanged state (the command is skipped).
func stepPure(st *State, cmd Cmd) (*State, string) {
	switch cmd := cmd.(type) {
	case New:
		if st.get(cmd.Name).Live {
			return st, fmt.Sprintf("new %s: name already live", cmd.Name)
		}
		st = st.clone()
		st.set(cmd.Name, Sym{Kind: Owner, Live: true})
		return st, ""
	case Share:
		o := st.get(cmd.Owner)
		if !o.Live {
			return st, fmt.Sprintf("share %s = &%s: owner not live", cmd.Borrow, cmd.Owner)
		}
		if o.Kind != Owner {
			return st, fmt.Sprintf("share %s = &%s: cannot borrow a borrow", cmd.Borrow, cmd.Owner)
		}
		if st.get(cmd.Borrow).Live {
			return st, fmt.Sprintf("share %s: name already live", cmd.Borrow)
		}
		for _, b := range st.liveBorrowsOf(cmd.Owner) {
			if st.get(b).Kind == Exclusive {
				return st, fmt.Sprintf("share %s = &%s: exclusive borrow %s is live", cmd.Borrow, cmd.Owner, b)
			}
		}
		st = st.clone()
		st.set(cmd.Borrow, Sym{Kind: Shared, Live: true, Target: cmd.Owner})
		return st, ""
	case Excl:
		o := st.get(cmd.Owner)
		if !o.Live {
			return st, fmt.Sprintf("excl %s = &mut %s: owner not live", cmd.Borrow, cmd.Owner)
		}
		if o.Kind != Owner {
			return st, fmt.Sprintf("excl %s = &mut %s: cannot borrow a borrow", cmd.Borrow, cmd.Owner)
		}
		if st.get(cmd.Borrow).Live {
			return st, fmt.Sprintf("excl %s: name already live", cmd.Borrow)
		}
		if bs := st.liveBorrowsOf(cmd.Owner); len(bs) > 0 {
			return st, fmt.Sprintf("excl %s = &mut %s: borrow %s is live", cmd.Borrow, cmd.Owner, strings.Join(bs, ","))
		}
		st = st.clone()
		st.set(cmd.Borrow, Sym{Kind: Exclusive, Live: true, Target: cmd.Owner})
		return st, ""
	case Use:
		s := st.get(cmd.Name)
		if !s.Live {
			return st, fmt.Sprintf("use %s: not live", cmd.Name)
		}
		if s.Kind == Owner {
			for _, b := range st.liveBorrowsOf(cmd.Name) {
				if st.get(b).Kind == Exclusive {
					return st, fmt.Sprintf("use %s: aliased access during exclusive borrow %s", cmd.Name, b)
				}
			}
		}
		return st, ""
	case Mut:
		s := st.get(cmd.Name)
		if !s.Live {
			return st, fmt.Sprintf("mut %s: not live", cmd.Name)
		}
		switch s.Kind {
		case Owner:
			if bs := st.liveBorrowsOf(cmd.Name); len(bs) > 0 {
				return st, fmt.Sprintf("mut %s: borrowed by %s", cmd.Name, strings.Join(bs, ","))
			}
		case Shared:
			return st, fmt.Sprintf("mut %s: cannot write through a shared borrow", cmd.Name)
		}
		return st, ""
	case Move:
		s := st.get(cmd.Src)
		if !s.Live {
			return st, fmt.Sprintf("move %s = %s: source not live", cmd.Dst, cmd.Src)
		}
		if st.get(cmd.Dst).Live {
			return st, fmt.Sprintf("move %s = %s: destination already live", cmd.Dst, cmd.Src)
		}
		if s.Kind == Owner {
			if bs := st.liveBorrowsOf(cmd.Src); len(bs) > 0 {
				return st, fmt.Sprintf("move %s = %s: owner borrowed by %s", cmd.Dst, cmd.Src, strings.Join(bs, ","))
			}
		}
		st = st.clone()
		st.set(cmd.Dst, Sym{Kind: s.Kind, Live: true, Target: s.Target})
		st.set(cmd.Src, Sym{})
		return st, ""
	case Drop:
		s := st.get(cmd.Name)
		if !s.Live {
			return st, fmt.Sprintf("drop %s: not live", cmd.Name)
		}
		if s.Kind == Owner {
			if bs := st.liveBorrowsOf(cmd.Name); len(bs) > 0 {
				return st, fmt.Sprintf("drop %s: borrow %s would outlive its owner", cmd.Name, strings.Join(bs, ","))
			}
		}
		st = st.clone()
		st.set(cmd.Name, Sym{})
		return st, ""
	}
	return st, "unknown command"
}

// Check analyses prog path-sensitively and returns every violation
// found, each with its command path. A nil/empty result means the
// program respects all borrow rules.
func Check(prog []Cmd) []Violation {
	c := &checker{}
	c.run(newState(), prog, nil)
	return c.violations
}

type checker struct {
	violations []Violation
}

func (c *checker) fail(path []string, reason string) {
	p := make([]string, len(path))
	copy(p, path)
	c.violations = append(c.violations, Violation{Path: p, Reason: reason})
}

func extend(path []string, s string) []string {
	out := make([]string, len(path)+1)
	copy(out, path)
	out[len(path)] = s
	return out
}

// run executes cmds from st and returns the exit state.
func (c *checker) run(st *State, cmds []Cmd, path []string) *State {
	for _, cmd := range cmds {
		path = extend(path, CmdString(cmd))
		if br, ok := cmd.(If); ok {
			thenSt := c.run(st.clone(), br.Then, extend(path, "[then]"))
			elseSt := c.run(st.clone(), br.Else, extend(path, "[else]"))
			if diff, ok := compatible(thenSt, elseSt); !ok {
				c.fail(path, "incompatible branch merge: "+diff)
			}
			st = thenSt
			continue
		}
		next, err := stepPure(st, cmd)
		if err != "" {
			c.fail(path, err)
		}
		st = next
	}
	return st
}
