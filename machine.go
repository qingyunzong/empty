package interp

import "fmt"

// Status reports why the machine stopped.
type Status int

const (
	Running Status = iota
	Done
	Suspended // step budget exhausted; state is preserved and resumable
	Failed    // uncaught exception or fatal error
)

type frameKind int

const (
	fIf frameKind = iota
	fBegin
	fFun          // operator evaluated, operands pending
	fArg          // some operands evaluated
	fBoundary     // function-entry marker (return address)
	fHandler      // pending catch
	fFinally      // pending finally
	fFinallyDone  // finally cleanup running after normal return
	fFinallyThrow // finally cleanup running during unwind
	fThrow        // operand of throw evaluated
)

// frame is one continuation frame on the machine's explicit stack.
type frame struct {
	kind frameKind
	env  *Env

	then *Node   // fIf
	els  *Node   // fIf
	rest []*Node // fBegin
	args []*Node // fFun

	fun  Value   // fArg
	done []Value // fArg
	todo []*Node // fArg

	cleanup []*Node // fFinally
	saved   Value   // fFinallyDone
	exc     Value   // fFinallyThrow

	param string  // fHandler
	body  []*Node // fHandler
}

// Machine is a CESK-style interpreter with an explicit control stack.
// Because the whole continuation lives in Stack (not the Go call stack),
// the machine can:
//   - eliminate tail calls by reusing the top fBoundary frame, but only
//     when no finally/handler frame is pending above it;
//   - suspend when the step budget runs out, preserving full state;
//   - be serialized to JSON and resumed later (see serialize.go).
type Machine struct {
	expr   *Node // control: expression to evaluate (hasVal == false)
	val    Value // control: produced value (hasVal == true)
	hasVal bool
	env    *Env
	stack  []frame

	// Steps is the remaining evaluation budget. Run stops with
	// Status == Suspended when it reaches zero.
	Steps int64

	// Log records (log ...) calls, including those in finally clauses;
	// tests compare it against the reference interpreter.
	Log []string

	// MaxDepth is the high-water mark of len(stack), for TCO assertions.
	MaxDepth int

	Status Status
	Result Value
	Err    string
}

// NewMachine builds a machine that evaluates prog with the given budget.
func NewMachine(prog *Node, steps int64) *Machine {
	return &Machine{expr: prog, env: &Env{Vars: map[string]Value{}}, Steps: steps}
}

// Run executes until Done, Suspended, or Failed.
func (m *Machine) Run() {
	for m.Status == Running {
		if m.Steps <= 0 {
			m.Status = Suspended
			return
		}
		m.Steps--
		m.step()
	}
}

// Resume adds budget and continues a suspended machine.
func (m *Machine) Resume(steps int64) {
	m.Steps += steps
	if m.Status == Suspended {
		m.Status = Running
	}
	m.Run()
}

func (m *Machine) push(f frame) {
	m.stack = append(m.stack, f)
	if len(m.stack) > m.MaxDepth {
		m.MaxDepth = len(m.stack)
	}
}

func (m *Machine) pop() frame {
	f := m.stack[len(m.stack)-1]
	m.stack = m.stack[:len(m.stack)-1]
	return f
}

func (m *Machine) deliver(v Value) {
	m.val = v
	m.hasVal = true
	m.expr = nil
}

func (m *Machine) eval(n *Node) {
	m.expr = n
	m.hasVal = false
}

// evalBody evaluates a body (begin semantics). The last expression is
// evaluated in tail position: no frame is pushed for it.
func (m *Machine) evalBody(body []*Node) {
	switch len(body) {
	case 0:
		m.deliver(Value{Kind: VNil})
	case 1:
		m.eval(body[0])
	default:
		m.push(frame{kind: fBegin, env: m.env, rest: body[1:]})
		m.eval(body[0])
	}
}

func (m *Machine) step() {
	if !m.hasVal {
		m.stepEval()
		return
	}
	m.stepValue()
}

func (m *Machine) stepEval() {
	n := m.expr
	switch n.Kind {
	case KNil:
		m.deliver(Value{Kind: VNil})
	case KBool:
		m.deliver(Value{Kind: VBool, Num: n.Num})
	case KInt:
		m.deliver(Value{Kind: VInt, Num: n.Num})
	case KStr:
		m.deliver(Value{Kind: VStr, Str: n.Str})
	case KSym:
		if v, ok := m.env.lookup(n.Sym); ok {
			m.deliver(v)
		} else if _, isPrim := Prims[n.Sym]; isPrim {
			m.deliver(Value{Kind: VPrim, Prim: n.Sym})
		} else {
			m.raise(Value{Kind: VStr, Str: "unbound variable: " + n.Sym})
		}
	case KIf:
		m.push(frame{kind: fIf, env: m.env, then: n.Then, els: n.Else})
		m.eval(n.Cond)
	case KBegin:
		m.evalBody(n.Body)
	case KLambda:
		m.deliver(Value{Kind: VClosure, Clo: &Closure{
			Name: n.Name, Params: n.Params, Body: n.Body, Env: m.env,
		}})
	case KCall:
		m.push(frame{kind: fFun, env: m.env, args: n.Args})
		m.eval(n.Func)
	case KThrow:
		m.push(frame{kind: fThrow})
		m.eval(n.Sub)
	case KTry:
		// Finally is outermost so it also covers exceptions from the
		// handler; the handler sits closer to the body.
		if n.HasFinal {
			m.push(frame{kind: fFinally, env: m.env, cleanup: n.Final})
		}
		if n.HasCatch {
			m.push(frame{kind: fHandler, env: m.env, param: n.CatchParam, body: n.Catch})
		}
		m.evalBody(n.Body)
	default:
		m.fail(fmt.Sprintf("bad node kind %d", n.Kind))
	}
}

func (m *Machine) stepValue() {
	if len(m.stack) == 0 {
		m.Result = m.val
		m.Status = Done
		return
	}
	v := m.val
	f := m.pop()
	switch f.kind {
	case fIf:
		m.env = f.env
		if truthy(v) {
			m.eval(f.then)
		} else {
			m.eval(f.els)
		}
	case fBegin:
		m.env = f.env
		m.evalBody(f.rest)
	case fFun:
		m.env = f.env
		if len(f.args) == 0 {
			m.apply(v, nil)
		} else {
			m.push(frame{kind: fArg, env: f.env, fun: v, todo: f.args[1:]})
			m.eval(f.args[0])
		}
	case fArg:
		m.env = f.env
		done := append(append([]Value{}, f.done...), v)
		if len(f.todo) > 0 {
			m.push(frame{kind: fArg, env: f.env, fun: f.fun, done: done, todo: f.todo[1:]})
			m.eval(f.todo[0])
		} else {
			m.apply(f.fun, done)
		}
	case fThrow:
		m.raise(v)
	case fBoundary:
		// Non-tail call returned; value propagates to the caller's frames.
		m.deliver(v)
	case fHandler:
		// Body completed normally; the handler is no longer needed.
		m.deliver(v)
	case fFinally:
		// Body completed normally: run cleanup, then re-deliver v.
		m.push(frame{kind: fFinallyDone, saved: v})
		m.env = f.env
		m.evalBody(f.cleanup)
	case fFinallyDone:
		m.deliver(f.saved)
	case fFinallyThrow:
		m.raise(f.exc)
	default:
		m.fail(fmt.Sprintf("bad frame kind %d", f.kind))
	}
}

// apply calls fun. A tail call — one made when the current function has no
// pending work, i.e. the stack top is a boundary (or the stack is empty) —
// reuses the existing boundary instead of pushing a new one, so the stack
// does not grow. A pending finally or handler frame blocks elimination,
// because it must observe the callee's return or exception.
func (m *Machine) apply(fun Value, args []Value) {
	switch fun.Kind {
	case VPrim:
		p, ok := Prims[fun.Prim]
		if !ok {
			m.raise(Value{Kind: VStr, Str: "unknown primitive: " + fun.Prim})
			return
		}
		res, err := p(&m.Log, args)
		if err != nil {
			m.raise(Value{Kind: VStr, Str: err.Error()})
			return
		}
		m.deliver(res)
	case VClosure:
		c := fun.Clo
		if len(args) != len(c.Params) {
			m.raise(Value{Kind: VStr, Str: fmt.Sprintf(
				"arity mismatch: want %d got %d", len(c.Params), len(args))})
			return
		}
		tail := len(m.stack) == 0 || m.stack[len(m.stack)-1].kind == fBoundary
		if !tail {
			m.push(frame{kind: fBoundary})
		}
		env := extend(c.Env, c.Params, args)
		if c.Name != "" {
			env.Vars[c.Name] = fun
		}
		m.env = env
		m.evalBody(c.Body)
	default:
		m.raise(Value{Kind: VStr, Str: "not applicable: " + Show(fun)})
	}
}

// raise unwinds the stack looking for a handler, running finally cleanups
// on the way out. With no handler the machine fails.
func (m *Machine) raise(exc Value) {
	for len(m.stack) > 0 {
		f := m.pop()
		switch f.kind {
		case fHandler:
			m.env = extend(f.env, []string{f.param}, []Value{exc})
			m.evalBody(f.body)
			return
		case fFinally:
			m.push(frame{kind: fFinallyThrow, exc: exc})
			m.env = f.env
			m.evalBody(f.cleanup)
			return
		}
	}
	m.fail("uncaught exception: " + Show(exc))
}

func (m *Machine) fail(msg string) {
	m.Err = msg
	m.Status = Failed
}
