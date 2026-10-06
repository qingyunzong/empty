package linearchk

import (
	"fmt"
	"sort"
)

// Exploration is the result of exhaustively enumerating the finite
// state space of a program.
type Exploration struct {
	// States is the sorted set of reachable abstract states, in
	// canonical form ("x:owner;r:shared->x;").
	States []string
	// Bad lists every bad transition and incompatible join found,
	// each with a witness path.
	Bad []Violation
}

// instr is a flattened command. next is the fall-through successor;
// for If, alt is the else-branch entry and join the merge point.
type instr struct {
	cmd  Cmd
	next int
	alt  int // If only: else entry
	join int // If only: merge pc, else -1
}

func flatten(prog []Cmd) []instr {
	var ins []instr
	var emit func(cmds []Cmd)
	emit = func(cmds []Cmd) {
		for _, c := range cmds {
			if br, ok := c.(If); ok {
				ifPC := len(ins)
				ins = append(ins, instr{}) // placeholder
				thenStart := len(ins)
				emit(br.Then)
				thenJump := len(ins)
				ins = append(ins, instr{cmd: nil}) // jump to join
				elseStart := len(ins)
				emit(br.Else)
				elseJump := len(ins)
				ins = append(ins, instr{cmd: nil}) // jump to join
				join := len(ins)
				ins[ifPC] = instr{cmd: br, next: thenStart, alt: elseStart, join: join}
				ins[thenJump].next = join
				ins[elseJump].next = join
				continue
			}
			ins = append(ins, instr{cmd: c, next: len(ins) + 1, join: -1})
		}
	}
	emit(prog)
	return ins
}

// Explore enumerates every reachable (pc, state) pair of prog by
// breadth-first search. The state space is finite: finitely many names,
// each dead or one of three kinds with a finite target set. Bad
// transitions (rule breaches) are recorded and skipped, mirroring
// Check; states arriving at each join point must agree, mirroring the
// branch-merge rule.
func Explore(prog []Cmd) Exploration {
	ins := flatten(prog)
	joinSet := map[int]bool{}
	for _, in := range ins {
		if in.join >= 0 {
			joinSet[in.join] = true
		}
	}
	type node struct {
		pc  int
		key string
	}
	type edge struct {
		from  node
		label string
	}
	seen := map[node]bool{}
	parent := map[node]edge{}
	states := map[string]bool{}
	var bad []Violation
	joinStates := map[int]map[string]node{} // join pc -> state key -> exemplar

	pathTo := func(n node) []string {
		var rev []string
		for {
			e, ok := parent[n]
			if !ok {
				break
			}
			if e.label != "" {
				rev = append(rev, e.label)
			}
			n = e.from
		}
		for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
			rev[i], rev[j] = rev[j], rev[i]
		}
		return rev
	}
	record := func(n node, cmd Cmd, reason string) {
		bad = append(bad, Violation{Path: append(pathTo(n), CmdString(cmd)), Reason: reason})
	}

	start := node{pc: 0, key: newState().key()}
	env := map[node]*State{start: newState()}
	queue := []node{start}
	seen[start] = true

	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		st := env[n]
		states[n.key] = true
		if n.pc >= len(ins) {
			continue
		}
		in := ins[n.pc]
		push := func(pc int, nst *State, label string) {
			m := node{pc: pc, key: nst.key()}
			if joinSet[pc] {
				if _, ok := joinStates[pc]; !ok {
					joinStates[pc] = map[string]node{}
				}
				joinStates[pc][m.key] = m
			}
			if seen[m] {
				return
			}
			seen[m] = true
			parent[m] = edge{from: n, label: label}
			env[m] = nst
			queue = append(queue, m)
		}
		switch {
		case in.cmd == nil: // jump to join
			push(in.next, st, "")
		case isIf(in.cmd):
			push(in.next, st, "[then]")
			push(in.alt, st, "[else]")
		default:
			nst, err := stepPure(st, in.cmd)
			if err != "" {
				record(n, in.cmd, err)
			}
			push(in.next, nst, CmdString(in.cmd))
		}
	}

	// Join points: all arriving states must agree (branch-merge rule).
	joinPCs := make([]int, 0, len(joinStates))
	for pc := range joinStates {
		joinPCs = append(joinPCs, pc)
	}
	sort.Ints(joinPCs)
	for _, pc := range joinPCs {
		arrivals := joinStates[pc]
		if len(arrivals) <= 1 {
			continue
		}
		keys := make([]string, 0, len(arrivals))
		for k := range arrivals {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		witness := arrivals[keys[0]]
		bad = append(bad, Violation{
			Path:   pathTo(witness),
			Reason: fmt.Sprintf("incompatible branch merge: states %v reach the same join", keys),
		})
	}

	out := Exploration{Bad: bad}
	for k := range states {
		out.States = append(out.States, k)
	}
	sort.Strings(out.States)
	return out
}

func isIf(c Cmd) bool {
	_, ok := c.(If)
	return ok
}
