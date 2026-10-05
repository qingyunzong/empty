package interp

import "fmt"

// Ref is the reference interpreter: a plain recursive tree-walking
// evaluator. It never eliminates tail calls (each call consumes Go stack),
// which makes it the semantic ground truth for cross-checking the Machine:
// both must produce the same final value and the same cleanup log.
//
// It shares the Machine's observable semantics — lexical scoping, throw /
// catch / finally, primitive behavior — but is intentionally implemented
// independently.
type Ref struct {
	Log   []string
	depth int
}

// MaxRefDepth bounds the reference evaluator's recursion so runaway
// programs fail cleanly instead of overflowing the Go stack.
const MaxRefDepth = 100000

// thrown is the internal non-local exit used for (throw ...).
type thrown struct{ v Value }

func (t thrown) Error() string { return "uncaught exception: " + Show(t.v) }

// Eval evaluates prog to a value. A propagated *thrown means an uncaught
// exception.
func (r *Ref) Eval(prog *Node) (Value, error) {
	v, err := r.eval(prog, &Env{Vars: map[string]Value{}})
	if err != nil {
		if t, ok := err.(thrown); ok {
			return Value{}, fmt.Errorf("uncaught exception: %s", Show(t.v))
		}
		return Value{}, err
	}
	return v, nil
}

func (r *Ref) eval(n *Node, env *Env) (Value, error) {
	r.depth++
	if r.depth > MaxRefDepth {
		r.depth--
		return Value{}, fmt.Errorf("reference recursion limit exceeded")
	}
	v, err := r.evalInner(n, env)
	r.depth--
	return v, err
}

func (r *Ref) evalInner(n *Node, env *Env) (Value, error) {
	switch n.Kind {
	case KNil:
		return Value{Kind: VNil}, nil
	case KBool:
		return Value{Kind: VBool, Num: n.Num}, nil
	case KInt:
		return Value{Kind: VInt, Num: n.Num}, nil
	case KStr:
		return Value{Kind: VStr, Str: n.Str}, nil
	case KSym:
		if v, ok := env.lookup(n.Sym); ok {
			return v, nil
		}
		if _, isPrim := Prims[n.Sym]; isPrim {
			return Value{Kind: VPrim, Prim: n.Sym}, nil
		}
		return Value{}, thrown{Value{Kind: VStr, Str: "unbound variable: " + n.Sym}}
	case KIf:
		c, err := r.eval(n.Cond, env)
		if err != nil {
			return Value{}, err
		}
		if truthy(c) {
			return r.eval(n.Then, env)
		}
		return r.eval(n.Else, env)
	case KBegin:
		return r.evalBody(n.Body, env)
	case KLambda:
		return Value{Kind: VClosure, Clo: &Closure{
			Name: n.Name, Params: n.Params, Body: n.Body, Env: env,
		}}, nil
	case KCall:
		fn, err := r.eval(n.Func, env)
		if err != nil {
			return Value{}, err
		}
		args := make([]Value, 0, len(n.Args))
		for _, a := range n.Args {
			v, err := r.eval(a, env)
			if err != nil {
				return Value{}, err
			}
			args = append(args, v)
		}
		return r.apply(fn, args)
	case KThrow:
		v, err := r.eval(n.Sub, env)
		if err != nil {
			return Value{}, err
		}
		return Value{}, thrown{v}
	case KTry:
		return r.evalTry(n, env)
	}
	return Value{}, fmt.Errorf("bad node kind %d", n.Kind)
}

func (r *Ref) evalBody(body []*Node, env *Env) (Value, error) {
	v := Value{Kind: VNil}
	var err error
	for _, e := range body {
		v, err = r.eval(e, env)
		if err != nil {
			return Value{}, err
		}
	}
	return v, nil
}

func (r *Ref) evalTry(n *Node, env *Env) (Value, error) {
	v, err := r.evalBody(n.Body, env)
	if err != nil && n.HasCatch {
		if t, ok := err.(thrown); ok {
			henv := extend(env, []string{n.CatchParam}, []Value{t.v})
			v, err = r.evalBody(n.Catch, henv)
		}
	}
	if n.HasFinal {
		// Cleanup runs on both the normal and the exceptional path; an
		// exception escaping cleanup replaces any in-flight outcome.
		if _, ferr := r.evalBody(n.Final, env); ferr != nil {
			return Value{}, ferr
		}
	}
	return v, err
}

func (r *Ref) apply(fun Value, args []Value) (Value, error) {
	switch fun.Kind {
	case VPrim:
		p, ok := Prims[fun.Prim]
		if !ok {
			return Value{}, thrown{Value{Kind: VStr, Str: "unknown primitive: " + fun.Prim}}
		}
		res, err := p(&r.Log, args)
		if err != nil {
			return Value{}, thrown{Value{Kind: VStr, Str: err.Error()}}
		}
		return res, nil
	case VClosure:
		c := fun.Clo
		if len(args) != len(c.Params) {
			return Value{}, thrown{Value{Kind: VStr, Str: fmt.Sprintf(
				"arity mismatch: want %d got %d", len(c.Params), len(args))}}
		}
		env := extend(c.Env, c.Params, args)
		if c.Name != "" {
			env.Vars[c.Name] = fun
		}
		return r.evalBody(c.Body, env)
	}
	return Value{}, thrown{Value{Kind: VStr, Str: "not applicable: " + Show(fun)}}
}
