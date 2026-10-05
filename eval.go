package macro

import "fmt"

// Macro is a transformer registered by defmacro. DefEnv is the
// definition-time environment, giving macro bodies lexical scope.
type Macro struct {
	Name   Symbol
	Params []Symbol
	Body   Value
	DefEnv *Env
}

// Eval evaluates an already-expanded expression.
func Eval(env *Env, expr Value) (Value, error) {
	switch e := expr.(type) {
	case Symbol:
		v, ok := env.Lookup(e)
		if !ok {
			return nil, fmt.Errorf("undefined symbol: %s", e)
		}
		return v, nil
	case List:
		return evalList(env, e)
	default:
		return e, nil
	}
}

func evalList(env *Env, e List) (Value, error) {
	if len(e) == 0 {
		return nil, fmt.Errorf("cannot evaluate empty list")
	}
	if head, ok := e[0].(Symbol); ok {
		switch head {
		case "quote":
			if len(e) != 2 {
				return nil, fmt.Errorf("quote: expected 1 arg")
			}
			return e[1], nil
		case "if":
			if len(e) != 4 {
				return nil, fmt.Errorf("if: expected (if cond then else)")
			}
			cond, err := Eval(env, e[1])
			if err != nil {
				return nil, err
			}
			b, ok := cond.(Bool)
			if !ok {
				return nil, fmt.Errorf("if: condition must be boolean, got %v", cond)
			}
			if b {
				return Eval(env, e[2])
			}
			return Eval(env, e[3])
		case "let":
			return evalLet(env, e)
		case "def":
			if len(e) != 3 {
				return nil, fmt.Errorf("def: expected (def name expr)")
			}
			name, ok := e[1].(Symbol)
			if !ok {
				return nil, fmt.Errorf("def: name must be a symbol")
			}
			v, err := Eval(env, e[2])
			if err != nil {
				return nil, err
			}
			env.Define(name, v)
			return v, nil
		case "defmacro":
			return evalDefmacro(env, e)
		case "begin":
			var out Value = Bool(false)
			for _, sub := range e[1:] {
				v, err := Eval(env, sub)
				if err != nil {
					return nil, err
				}
				out = v
			}
			return out, nil
		}
	}
	fn, err := Eval(env, e[0])
	if err != nil {
		return nil, err
	}
	if _, isMacro := fn.(*Macro); isMacro {
		return nil, fmt.Errorf("macro %s reached evaluator unexpanded", e[0])
	}
	b, ok := fn.(Builtin)
	if !ok {
		return nil, fmt.Errorf("not applicable: %v", e[0])
	}
	args := make([]Value, 0, len(e)-1)
	for _, a := range e[1:] {
		v, err := Eval(env, a)
		if err != nil {
			return nil, err
		}
		args = append(args, v)
	}
	return b(args)
}

// evalLet evaluates a parallel let: all init expressions are evaluated
// in the outer environment, then bindings are installed in a child frame.
func evalLet(env *Env, e List) (Value, error) {
	if len(e) < 3 {
		return nil, fmt.Errorf("let: expected (let ((v e) ...) body ...)")
	}
	binds, ok := e[1].(List)
	if !ok {
		return nil, fmt.Errorf("let: malformed bindings")
	}
	type binding struct {
		name Symbol
		val  Value
	}
	ready := make([]binding, 0, len(binds))
	for _, b := range binds {
		pair, ok := b.(List)
		if !ok || len(pair) != 2 {
			return nil, fmt.Errorf("let: malformed binding %v", b)
		}
		name, ok := pair[0].(Symbol)
		if !ok {
			return nil, fmt.Errorf("let: binding name must be a symbol")
		}
		v, err := Eval(env, pair[1])
		if err != nil {
			return nil, err
		}
		ready = append(ready, binding{name, v})
	}
	child := NewEnv(env)
	for _, bd := range ready {
		child.Define(bd.name, bd.val)
	}
	var out Value = Bool(false)
	for _, bodyExpr := range e[2:] {
		v, err := Eval(child, bodyExpr)
		if err != nil {
			return nil, err
		}
		out = v
	}
	return out, nil
}

func evalDefmacro(env *Env, e List) (Value, error) {
	if len(e) != 4 {
		return nil, fmt.Errorf("defmacro: expected (defmacro name (params...) body)")
	}
	name, ok := e[1].(Symbol)
	if !ok {
		return nil, fmt.Errorf("defmacro: name must be a symbol")
	}
	params, ok := e[2].(List)
	if !ok {
		return nil, fmt.Errorf("defmacro: params must be a list")
	}
	m := &Macro{Name: name, DefEnv: env, Body: e[3]}
	for _, p := range params {
		s, ok := p.(Symbol)
		if !ok {
			return nil, fmt.Errorf("defmacro: param must be a symbol")
		}
		m.Params = append(m.Params, s)
	}
	env.Define(name, m)
	return name, nil
}
