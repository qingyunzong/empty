package rescheck

import (
	"fmt"
	"sort"
	"strings"
)

// Abs is the abstract per-variable state. The domain is finite and forms
// a lattice of height 3:
//
//	     Conflict (top: states disagree across paths)
//	   /     |      \
//	Live   Moved   Consumed
//	   \     |      /
//	      Uninit (bottom: no resource ever bound)
type Abs uint8

const (
	Uninit Abs = iota
	Live
	Moved
	Consumed
	Conflict
)

func (a Abs) String() string {
	switch a {
	case Uninit:
		return "uninit"
	case Live:
		return "live"
	case Moved:
		return "moved"
	case Consumed:
		return "consumed"
	case Conflict:
		return "conflict"
	}
	return "?"
}

// State is the abstract program state: a per-variable mapping plus a
// witness path (block labels) showing how this state was reached. Way is
// diagnostic only; it never affects fixed-point convergence.
type State struct {
	Vars map[string]Abs
	Way  []string
}

func newState() *State { return &State{Vars: map[string]Abs{}} }

func (s *State) clone() *State {
	n := &State{Vars: make(map[string]Abs, len(s.Vars))}
	for k, v := range s.Vars {
		n.Vars[k] = v
	}
	n.Way = append([]string(nil), s.Way...)
	return n
}

func (s *State) get(v string) Abs { return s.Vars[v] } // zero value is Uninit

// maxWay caps witness-path length so loops cannot grow it without bound.
const maxWay = 64

func (s *State) enter(label string) {
	if len(s.Way) < maxWay {
		s.Way = append(s.Way, label)
	}
}

func equalVars(a, b *State) bool {
	if len(a.Vars) != len(b.Vars) {
		return false
	}
	for k, v := range a.Vars {
		if b.Vars[k] != v {
			return false
		}
	}
	return true
}

// joinInto merges b into a in place following the lattice: Uninit is
// bottom, equal states pass through, anything else becomes Conflict.
func joinInto(a, b *State) {
	for k, bv := range b.Vars {
		av := a.Vars[k]
		switch {
		case av == Uninit:
			a.Vars[k] = bv
		case bv == Uninit:
			// keep av
		case av != bv:
			a.Vars[k] = Conflict
		}
	}
	if len(b.Way) < len(a.Way) || a.Way == nil {
		a.Way = append([]string(nil), b.Way...)
	}
}

// Violation describes one protocol breach together with a concrete
// witness path (block labels from the entry block).
type Violation struct {
	Kind  string
	Var   string
	Block string
	Path  []string
	Note  string
}

func (v Violation) String() string {
	s := fmt.Sprintf("%-20s var=%s block=%s path=%s",
		v.Kind, v.Var, v.Block, strings.Join(v.Path, " -> "))
	if v.Note != "" {
		s += " (" + v.Note + ")"
	}
	return s
}

// step applies one instruction to the abstract state, emitting violations.
// It is shared by the dataflow analysis and the path expansion; the
// transfer functions are monotone on the lattice, which guarantees
// termination of the fixed-point iteration.
func step(s *State, ins Instr, blk *Block, emit func(Violation)) {
	at := func(kind, var_, note string) {
		emit(Violation{
			Kind:  kind,
			Var:   var_,
			Block: blk.Label,
			Path:  append([]string(nil), s.Way...),
			Note:  note,
		})
	}
	switch ins.Op {
	case OpNew:
		if s.get(ins.Dst) == Live {
			at("overwrite-leak", ins.Dst, "resource overwritten while still live")
		}
		if s.get(ins.Dst) != Conflict {
			s.Vars[ins.Dst] = Live
		}
	case OpUse:
		switch s.get(ins.Dst) {
		case Live:
			s.Vars[ins.Dst] = Consumed
		case Consumed:
			at("double-consume", ins.Dst, "resource consumed more than once")
		case Moved:
			at("use-after-move", ins.Dst, "resource used after being moved away")
		case Uninit:
			at("use-before-init", ins.Dst, "resource used before creation")
		case Conflict:
			at("path-dependent-use", ins.Dst, "resource state differs across incoming paths")
		}
	case OpMove:
		src := s.get(ins.Src)
		switch src {
		case Live:
			s.Vars[ins.Src] = Moved
		case Moved:
			at("move-after-move", ins.Src, "resource moved twice")
		case Consumed:
			at("move-after-consume", ins.Src, "resource moved after consumption")
		case Uninit:
			at("move-before-init", ins.Src, "resource moved before creation")
		case Conflict:
			at("path-dependent-move", ins.Src, "resource state differs across incoming paths")
		}
		if src == Live {
			if s.get(ins.Dst) == Live {
				at("overwrite-leak", ins.Dst, "move target overwritten while live")
			}
			if s.get(ins.Dst) != Conflict {
				s.Vars[ins.Dst] = Live
			}
		}
	case OpReturn, OpPanic:
		kind := "leak-at-return"
		if ins.Op == OpPanic {
			kind = "leak-at-panic"
		}
		for _, v := range sortedKeys(s.Vars) {
			switch s.Vars[v] {
			case Live:
				at(kind, v, "live resource not consumed at exit")
			case Conflict:
				at("maybe-"+kind, v, "resource live on some incoming paths")
			}
		}
	}
}

func sortedKeys(m map[string]Abs) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// endsWithExit reports whether the block's last instruction is an
// explicit exit (Return or Panic).
func endsWithExit(b *Block) bool {
	if len(b.Instrs) == 0 {
		return false
	}
	op := b.Instrs[len(b.Instrs)-1].Op
	return op == OpReturn || op == OpPanic
}

// Result holds the output of the dataflow analysis.
type Result struct {
	In         map[*Block]*State // abstract state on block entry
	Out        map[*Block]*State // abstract state on block exit
	Violations []Violation       // deduplicated by (kind, var, block)
	Iterations int               // worklist iterations until fixed point
}

// Report renders the violations with their witness paths.
func (r *Result) Report() string {
	if len(r.Violations) == 0 {
		return "no violations"
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%d violation(s):\n", len(r.Violations))
	for _, v := range r.Violations {
		sb.WriteString("  " + v.String() + "\n")
	}
	return sb.String()
}

// Analyze runs a forward worklist dataflow analysis to a fixed point.
// Because the domain is finite and every transfer function is monotone,
// the iteration always terminates.
func Analyze(p *Program) *Result {
	p.Finalize()
	res := &Result{
		In:  map[*Block]*State{},
		Out: map[*Block]*State{},
	}
	seen := map[string]bool{}
	emit := func(v Violation) {
		key := v.Kind + "|" + v.Var + "|" + v.Block
		if !seen[key] {
			seen[key] = true
			res.Violations = append(res.Violations, v)
		}
	}

	in := map[*Block]*State{p.Entry: newState()}
	out := map[*Block]*State{}
	worklist := []*Block{p.Entry}
	queued := map[*Block]bool{p.Entry: true}

	for len(worklist) > 0 {
		b := worklist[0]
		worklist = worklist[1:]
		queued[b] = false

		var acc *State
		if b == p.Entry {
			acc = in[p.Entry]
		} else {
			for _, pred := range b.preds {
				po := out[pred]
				if po == nil {
					continue
				}
				if acc == nil {
					acc = po.clone()
					continue
				}
				// Merge point: report variables whose incoming states
				// genuinely disagree (both initialized, different values).
				for _, k := range sortedKeys(po.Vars) {
					av, bv := acc.Vars[k], po.Vars[k]
					if av != Uninit && bv != Uninit && av != bv {
						emit(Violation{
							Kind:  "merge-conflict",
							Var:   k,
							Block: b.Label,
							Path:  append([]string(nil), po.Way...),
							Note:  fmt.Sprintf("incoming edges disagree: %s vs %s", av, bv),
						})
					}
				}
				joinInto(acc, po)
			}
			if acc == nil {
				continue // not reachable yet
			}
			in[b] = acc
		}

		s := acc.clone()
		s.enter(b.Label)
		for _, ins := range b.Instrs {
			step(s, ins, b, emit)
		}
		if len(b.Succs) == 0 && !endsWithExit(b) {
			step(s, Ret(), b, emit) // falling off the end is an implicit return
		}

		if out[b] == nil || !equalVars(out[b], s) {
			out[b] = s
			for _, succ := range b.Succs {
				if !queued[succ] {
					worklist = append(worklist, succ)
					queued[succ] = true
				}
			}
		}
		res.Iterations++
	}

	res.In = in
	res.Out = out
	return res
}
