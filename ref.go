package interp

import "fmt"

// Ref is the reference interpreter: plain recursive evaluation, no tail-call
// elimination (every call grows the Go call stack). It shares the parser,
// values and builtins with Machine so tests can cross-check results.
type Ref struct {
	Out      []string
	depth    int
	MaxDepth int
}

// Log implements Logger for the emit builtin.
func (r *Ref) Log(s string) { r.Out = append(r.Out, s) }

// Run evaluates a program (sequence of top-level forms) to a value.
func (r *Ref) Run(prog []*Node, globals *Env) (Value, error) {
	return r.evalBegin(prog, globals)
}

func (r *Ref) evalBegin(body []*Node, e *Env) (Value, error) {
	var v Value
	for _, n := range body {
		var err error
		v, err = r.eval(n, e)
		if err != nil {
			return nil, err
		}
	}
	return v, nil
}

func (r *Ref) eval(n *Node, e *Env) (Value, error) {
	switch n.Kind {
	case NInt:
		return n.I, nil
	case NStr:
		return n.S, nil
	case NBool:
		return n.B, nil
	case NNil:
		return nil, nil
	case NSym:
		v, ok := e.lookup(n.S)
		if !ok {
			return nil, fmt.Errorf("unbound variable: %s", n.S)
		}
		return v, nil
	case NList:
		return r.evalList(n, e)
	}
	return nil, fmt.Errorf("bad node kind %d", n.Kind)
}

func (r *Ref) evalList(n *Node, e *Env) (Value, error) {
	head := n.Kids[0]
	if head.Kind == NSym {
		switch head.S {
		case "quote":
			if len(n.Kids) != 2 {
				return nil, fmt.Errorf("quote: need 1 argument")
			}
			return astToValue(n.Kids[1]), nil
		case "if":
			if len(n.Kids) < 3 || len(n.Kids) > 4 {
				return nil, fmt.Errorf("if: need 2 or 3 arguments")
			}
			c, err := r.eval(n.Kids[1], e)
			if err != nil {
				return nil, err
			}
			if truthy(c) {
				return r.eval(n.Kids[2], e)
			}
			if len(n.Kids) > 3 {
				return r.eval(n.Kids[3], e)
			}
			return nil, nil
		case "begin":
			return r.evalBegin(n.Kids[1:], e)
		case "define":
			return r.evalDefine(n, e)
		case "set!":
			if len(n.Kids) != 3 || n.Kids[1].Kind != NSym {
				return nil, fmt.Errorf("set!: malformed")
			}
			v, err := r.eval(n.Kids[2], e)
			if err != nil {
				return nil, err
			}
			if !e.assign(n.Kids[1].S, v) {
				return nil, fmt.Errorf("unbound variable: %s", n.Kids[1].S)
			}
			return v, nil
		case "lambda":
			if len(n.Kids) < 3 {
				return nil, fmt.Errorf("lambda: need params and body")
			}
			params, err := paramNames(n.Kids[1])
			if err != nil {
				return nil, err
			}
			return &Closure{Params: params, Body: n.Kids[2:], Env: e}, nil
		case "let":
			if len(n.Kids) < 3 {
				return nil, fmt.Errorf("let: need bindings and body")
			}
			names, exprs, err := parseBindings(n.Kids[1])
			if err != nil {
				return nil, err
			}
			env := &Env{Vars: make(map[string]Value, len(names)), Parent: e}
			for i, ex := range exprs {
				v, err := r.eval(ex, e)
				if err != nil {
					return nil, err
				}
				env.Vars[names[i]] = v
			}
			return r.evalBegin(n.Kids[2:], env)
		case "try":
			return r.evalTry(n, e)
		case "throw":
			if len(n.Kids) != 2 {
				return nil, fmt.Errorf("throw: need 1 argument")
			}
			v, err := r.eval(n.Kids[1], e)
			if err != nil {
				return nil, err
			}
			return nil, &Throw{Val: v}
		}
	}
	fn, err := r.eval(head, e)
	if err != nil {
		return nil, err
	}
	args := make([]Value, 0, len(n.Kids)-1)
	for _, a := range n.Kids[1:] {
		v, err := r.eval(a, e)
		if err != nil {
			return nil, err
		}
		args = append(args, v)
	}
	return r.apply(fn, args)
}

func (r *Ref) evalDefine(n *Node, e *Env) (Value, error) {
	if len(n.Kids) < 3 {
		return nil, fmt.Errorf("define: malformed")
	}
	tgt := n.Kids[1]
	if tgt.Kind == NList && len(tgt.Kids) > 0 && tgt.Kids[0].Kind == NSym {
		name := tgt.Kids[0].S
		var params []string
		for _, p := range tgt.Kids[1:] {
			if p.Kind != NSym {
				return nil, fmt.Errorf("define: parameter must be a symbol")
			}
			params = append(params, p.S)
		}
		clo := &Closure{Name: name, Params: params, Body: n.Kids[2:], Env: e}
		e.Vars[name] = clo
		return clo, nil
	}
	if tgt.Kind != NSym || len(n.Kids) != 3 {
		return nil, fmt.Errorf("define: malformed")
	}
	v, err := r.eval(n.Kids[2], e)
	if err != nil {
		return nil, err
	}
	e.Vars[tgt.S] = v
	if c, ok := v.(*Closure); ok && c.Name == "" {
		c.Name = tgt.S
	}
	return v, nil
}

func (r *Ref) evalTry(n *Node, e *Env) (Value, error) {
	tf, err := parseTry(n)
	if err != nil {
		return nil, err
	}
	v, err := r.evalBegin(tf.Body, e)
	if err != nil {
		if te, ok := err.(*Throw); ok && tf.HasCatch {
			// The catch handler runs before the finally cleanup.
			henv := &Env{Vars: map[string]Value{tf.CatchParam: te.Val}, Parent: e}
			v, err = r.evalBegin(tf.CatchBody, henv)
		}
	}
	if tf.HasFinally {
		if _, ferr := r.evalBegin(tf.FinallyBody, e); ferr != nil {
			return nil, ferr
		}
	}
	return v, err
}

func (r *Ref) apply(fn Value, args []Value) (Value, error) {
	switch f := fn.(type) {
	case *Builtin:
		bf, ok := builtins[f.Name]
		if !ok {
			return nil, fmt.Errorf("unknown builtin: %s", f.Name)
		}
		return bf(r, args)
	case *Closure:
		if len(args) != len(f.Params) {
			return nil, fmt.Errorf("arity mismatch: %s expects %d arguments, got %d",
				showValue(f), len(f.Params), len(args))
		}
		env := &Env{Vars: make(map[string]Value, len(f.Params)), Parent: f.Env}
		for i, p := range f.Params {
			env.Vars[p] = args[i]
		}
		r.depth++
		if r.depth > r.MaxDepth {
			r.MaxDepth = r.depth
		}
		defer func() { r.depth-- }()
		return r.evalBegin(f.Body, env)
	}
	return nil, fmt.Errorf("not applicable: %s", showValue(fn))
}
