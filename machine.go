package interp

import "fmt"

// FrameKind is the kind of a continuation frame on the machine stack.
type FrameKind int

const (
	KIf FrameKind = iota
	KBegin
	KDefine
	KSet
	KLet
	KArgs
	KThrow
	KFinally
)

// Frame is one continuation frame. A single struct with all fields keeps
// serialization simple.
type Frame struct {
	Kind      FrameKind
	Env       *Env
	Exprs     []*Node
	Body      []*Node
	Vals      []Value
	Names     []string
	Name      string
	Fn        Value
	Saved     Value
	Started   bool
	Unwinding bool
	PopH      bool
}

// Handler is a dynamically installed catch handler.
type Handler struct {
	Param    string
	Body     []*Node
	Env      *Env
	StackLen int
}

// Unwind is the in-flight state of an exception being unwound to its handler.
type Unwind struct {
	Value    Value
	StackLen int
	Param    string
	Body     []*Node
	Env      *Env
	Uncaught bool
}

// Status is the result of Run.
type Status int

const (
	StatusDone Status = iota
	StatusSuspended
	StatusFailed
)

func (s Status) String() string {
	switch s {
	case StatusDone:
		return "done"
	case StatusSuspended:
		return "suspended"
	case StatusFailed:
		return "failed"
	}
	return "?"
}

// Machine is a CEK-style evaluator with an explicit continuation stack.
// Tail calls never push a frame, so they run in constant stack space unless a
// finally continuation is pending. The whole state is serializable via Snapshot.
type Machine struct {
	Ctl      *Node
	Val      Value
	Ret      bool
	Env      *Env
	Stack    []*Frame
	Hnd      []*Handler
	Unw      *Unwind
	Out      []string
	Steps    int64
	MaxStack int
	Done     bool
	Err      string
}

// NewMachine builds a machine that evaluates a sequence of top-level forms.
func NewMachine(prog []*Node, globals *Env) *Machine {
	m := &Machine{}
	m.evalBeginIn(prog, globals)
	return m
}

// Log implements Logger for the emit builtin.
func (m *Machine) Log(s string) { m.Out = append(m.Out, s) }

func (m *Machine) fail(msg string) {
	if m.Err == "" {
		m.Err = msg
	}
}

// Run executes up to budget steps. If the budget is exhausted first, it
// returns StatusSuspended with the machine state fully preserved; call Run
// again (or Snapshot/Restore first) to continue.
func (m *Machine) Run(budget int64) Status {
	for i := int64(0); i < budget; i++ {
		if m.Err != "" {
			return StatusFailed
		}
		if m.Done {
			return StatusDone
		}
		m.Step()
	}
	if m.Err != "" {
		return StatusFailed
	}
	if m.Done {
		return StatusDone
	}
	return StatusSuspended
}

// Step executes a single evaluation step.
func (m *Machine) Step() {
	if m.Done || m.Err != "" {
		return
	}
	m.Steps++
	switch {
	case m.Unw != nil && !m.cleanupRunning():
		m.stepUnwind()
	case m.Ret:
		m.stepReturn()
	default:
		m.stepEval()
	}
	if m.Err == "" && m.Ret && m.Unw == nil && len(m.Stack) == 0 {
		m.Done = true
	}
}

func (m *Machine) push(f *Frame) {
	m.Stack = append(m.Stack, f)
	if len(m.Stack) > m.MaxStack {
		m.MaxStack = len(m.Stack)
	}
}

func (m *Machine) pop() { m.Stack = m.Stack[:len(m.Stack)-1] }

func (m *Machine) ret(v Value) { m.Val, m.Ret = v, true }

func (m *Machine) evalBeginIn(body []*Node, env *Env) {
	m.Env = env
	switch len(body) {
	case 0:
		m.ret(nil)
	case 1:
		m.Ctl, m.Ret = body[0], false
	default:
		m.push(&Frame{Kind: KBegin, Env: env, Exprs: body[1:]})
		m.Ctl, m.Ret = body[0], false
	}
}

func (m *Machine) stepEval() {
	n := m.Ctl
	switch n.Kind {
	case NInt:
		m.ret(n.I)
	case NStr:
		m.ret(n.S)
	case NBool:
		m.ret(n.B)
	case NNil:
		m.ret(nil)
	case NSym:
		v, ok := m.Env.lookup(n.S)
		if !ok {
			m.fail("unbound variable: " + n.S)
			return
		}
		m.ret(v)
	case NList:
		m.evalList(n)
	}
}

func (m *Machine) evalList(n *Node) {
	head := n.Kids[0]
	if head.Kind == NSym {
		switch head.S {
		case "quote":
			if len(n.Kids) != 2 {
				m.fail("quote: need 1 argument")
				return
			}
			m.ret(astToValue(n.Kids[1]))
			return
		case "if":
			if len(n.Kids) < 3 || len(n.Kids) > 4 {
				m.fail("if: need 2 or 3 arguments")
				return
			}
			m.push(&Frame{Kind: KIf, Env: m.Env, Exprs: n.Kids[2:]})
			m.Ctl = n.Kids[1]
			return
		case "begin":
			m.evalBeginIn(n.Kids[1:], m.Env)
			return
		case "define":
			m.evalDefine(n)
			return
		case "set!":
			if len(n.Kids) != 3 || n.Kids[1].Kind != NSym {
				m.fail("set!: malformed")
				return
			}
			m.push(&Frame{Kind: KSet, Env: m.Env, Name: n.Kids[1].S})
			m.Ctl = n.Kids[2]
			return
		case "lambda":
			if len(n.Kids) < 3 {
				m.fail("lambda: need params and body")
				return
			}
			params, err := paramNames(n.Kids[1])
			if err != nil {
				m.fail(err.Error())
				return
			}
			m.ret(&Closure{Params: params, Body: n.Kids[2:], Env: m.Env})
			return
		case "let":
			if len(n.Kids) < 3 {
				m.fail("let: need bindings and body")
				return
			}
			names, exprs, err := parseBindings(n.Kids[1])
			if err != nil {
				m.fail(err.Error())
				return
			}
			if len(exprs) == 0 {
				m.evalBeginIn(n.Kids[2:], &Env{Vars: map[string]Value{}, Parent: m.Env})
				return
			}
			m.push(&Frame{Kind: KLet, Env: m.Env, Names: names, Exprs: exprs[1:], Body: n.Kids[2:]})
			m.Ctl = exprs[0]
			return
		case "try":
			tf, err := parseTry(n)
			if err != nil {
				m.fail(err.Error())
				return
			}
			m.push(&Frame{Kind: KFinally, Env: m.Env, Exprs: tf.FinallyBody, PopH: tf.HasCatch})
			if tf.HasCatch {
				m.Hnd = append(m.Hnd, &Handler{
					Param:    tf.CatchParam,
					Body:     tf.CatchBody,
					Env:      m.Env,
					StackLen: len(m.Stack),
				})
			}
			m.evalBeginIn(tf.Body, m.Env)
			return
		case "throw":
			if len(n.Kids) != 2 {
				m.fail("throw: need 1 argument")
				return
			}
			m.push(&Frame{Kind: KThrow, Env: m.Env})
			m.Ctl = n.Kids[1]
			return
		}
	}
	// Function application.
	m.push(&Frame{Kind: KArgs, Env: m.Env, Exprs: n.Kids[1:]})
	m.Ctl = head
}

func (m *Machine) evalDefine(n *Node) {
	if len(n.Kids) < 3 {
		m.fail("define: malformed")
		return
	}
	tgt := n.Kids[1]
	if tgt.Kind == NList && len(tgt.Kids) > 0 && tgt.Kids[0].Kind == NSym {
		// (define (f args...) body...) sugar.
		name := tgt.Kids[0].S
		var params []string
		for _, p := range tgt.Kids[1:] {
			if p.Kind != NSym {
				m.fail("define: parameter must be a symbol")
				return
			}
			params = append(params, p.S)
		}
		clo := &Closure{Name: name, Params: params, Body: n.Kids[2:], Env: m.Env}
		m.Env.Vars[name] = clo
		m.ret(clo)
		return
	}
	if tgt.Kind != NSym || len(n.Kids) != 3 {
		m.fail("define: malformed")
		return
	}
	m.push(&Frame{Kind: KDefine, Env: m.Env, Name: tgt.S})
	m.Ctl = n.Kids[2]
}

func (m *Machine) stepReturn() {
	f := m.Stack[len(m.Stack)-1]
	switch f.Kind {
	case KIf:
		m.pop()
		m.Env = f.Env
		if truthy(m.Val) {
			m.Ctl, m.Ret = f.Exprs[0], false
		} else if len(f.Exprs) > 1 {
			m.Ctl, m.Ret = f.Exprs[1], false
		} else {
			m.Val = nil
		}
	case KBegin:
		if len(f.Exprs) > 0 {
			m.Ctl, m.Ret = f.Exprs[0], false
			f.Exprs = f.Exprs[1:]
			m.Env = f.Env
			return
		}
		m.pop()
		m.Env = f.Env
	case KDefine:
		m.pop()
		f.Env.Vars[f.Name] = m.Val
		if c, ok := m.Val.(*Closure); ok && c.Name == "" {
			c.Name = f.Name
		}
		m.Env = f.Env
	case KSet:
		m.pop()
		if !f.Env.assign(f.Name, m.Val) {
			m.fail("unbound variable: " + f.Name)
			return
		}
		m.Env = f.Env
	case KLet:
		f.Vals = append(f.Vals, m.Val)
		if len(f.Exprs) > 0 {
			m.Ctl, m.Ret = f.Exprs[0], false
			f.Exprs = f.Exprs[1:]
			m.Env = f.Env
			return
		}
		m.pop()
		env := &Env{Vars: make(map[string]Value, len(f.Names)), Parent: f.Env}
		for i, nm := range f.Names {
			env.Vars[nm] = f.Vals[i]
		}
		m.evalBeginIn(f.Body, env)
	case KArgs:
		if f.Fn == nil {
			f.Fn = m.Val
			if len(f.Exprs) == 0 {
				m.pop()
				m.apply(f.Fn, nil)
				return
			}
			m.Ctl, m.Ret = f.Exprs[0], false
			f.Exprs = f.Exprs[1:]
			m.Env = f.Env
			return
		}
		f.Vals = append(f.Vals, m.Val)
		if len(f.Exprs) > 0 {
			m.Ctl, m.Ret = f.Exprs[0], false
			f.Exprs = f.Exprs[1:]
			m.Env = f.Env
			return
		}
		m.pop()
		m.apply(f.Fn, f.Vals)
	case KThrow:
		m.pop()
		if len(m.Hnd) == 0 {
			// No handler: unwind the whole stack (running finally cleanups),
			// then fail.
			m.Unw = &Unwind{Value: m.Val, Uncaught: true}
			return
		}
		h := m.Hnd[len(m.Hnd)-1]
		m.Hnd = m.Hnd[:len(m.Hnd)-1]
		m.Unw = &Unwind{Value: m.Val, StackLen: h.StackLen, Param: h.Param, Body: h.Body, Env: h.Env}
	case KFinally:
		m.stepFinally(f)
	}
}

func (m *Machine) stepFinally(f *Frame) {
	if !f.Started {
		// Body (or catch handler) just produced a value; start the cleanup.
		f.Started = true
		f.Saved = m.Val
		if f.PopH {
			f.PopH = false
			m.Hnd = m.Hnd[:len(m.Hnd)-1]
		}
		if len(f.Exprs) == 0 {
			m.pop()
			m.Val = f.Saved
			return
		}
		m.Ctl, m.Ret = f.Exprs[0], false
		f.Exprs = f.Exprs[1:]
		m.Env = f.Env
		return
	}
	if len(f.Exprs) > 0 {
		m.Ctl, m.Ret = f.Exprs[0], false
		f.Exprs = f.Exprs[1:]
		m.Env = f.Env
		return
	}
	unwinding := f.Unwinding
	saved := f.Saved
	m.pop()
	if unwinding {
		// Cleanup done while unwinding; keep unwinding (m.Unw still set).
		m.Ret = false
		return
	}
	m.Val = saved
}

// cleanupRunning reports whether a finally cleanup started by the current
// unwind is still evaluating. While it runs, normal evaluation proceeds.
func (m *Machine) cleanupRunning() bool {
	for _, f := range m.Stack {
		if f.Kind == KFinally && f.Unwinding {
			return true
		}
	}
	return false
}

func (m *Machine) stepUnwind() {
	u := m.Unw
	if len(m.Stack) > u.StackLen {
		f := m.Stack[len(m.Stack)-1]
		if f.Kind == KFinally && !f.Started {
			// Pending finally on the unwind path: run its cleanup first.
			f.Started = true
			f.Unwinding = true
			if len(f.Exprs) == 0 {
				m.pop()
				return
			}
			m.Ctl, m.Ret = f.Exprs[0], false
			f.Exprs = f.Exprs[1:]
			m.Env = f.Env
			return
		}
		m.pop()
		return
	}
	if u.Uncaught {
		m.Unw = nil
		m.fail("uncaught exception: " + showValue(u.Value))
		return
	}
	// Reached the try that owns the handler: run the catch body, then let the
	// finally frame on top of the stack run its cleanup on completion.
	top := m.Stack[len(m.Stack)-1]
	top.PopH = false
	m.Unw = nil
	env := &Env{Vars: map[string]Value{u.Param: u.Value}, Parent: u.Env}
	m.evalBeginIn(u.Body, env)
}

func (m *Machine) apply(fn Value, args []Value) {
	switch f := fn.(type) {
	case *Builtin:
		bf, ok := builtins[f.Name]
		if !ok {
			m.fail("unknown builtin: " + f.Name)
			return
		}
		v, err := bf(m, args)
		if err != nil {
			m.fail(err.Error())
			return
		}
		m.ret(v)
	case *Closure:
		if len(args) != len(f.Params) {
			m.fail(fmt.Sprintf("arity mismatch: %s expects %d arguments, got %d",
				showValue(f), len(f.Params), len(args)))
			return
		}
		env := &Env{Vars: make(map[string]Value, len(f.Params)), Parent: f.Env}
		for i, p := range f.Params {
			env.Vars[p] = args[i]
		}
		// No frame is pushed here, so a call in tail position reuses the
		// current stack. If a finally continuation is pending it stays on the
		// stack and the call is effectively not eliminated.
		m.evalBeginIn(f.Body, env)
	default:
		m.fail("not applicable: " + showValue(fn))
	}
}
