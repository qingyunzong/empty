package macro

import (
	"fmt"
	"strings"
)

// Value is a runtime value: Int, Bool, Symbol, List, *Closure, *Macro, *Builtin.
type Value any

// Env is a lexical scope frame chained to its parent.
type Env struct {
	vars   map[string]Value
	parent *Env
}

func NewEnv(parent *Env) *Env {
	return &Env{vars: make(map[string]Value), parent: parent}
}

func (e *Env) Define(name string, v Value) {
	e.vars[name] = v
}

// Lookup resolves name through the lexical parent chain.
func (e *Env) Lookup(name string) (Value, bool) {
	for cur := e; cur != nil; cur = cur.parent {
		if v, ok := cur.vars[name]; ok {
			return v, true
		}
	}
	return nil, false
}

type Closure struct {
	Params []string
	Body   Expr
	Env    *Env // definition environment (lexical capture)
}

type Macro struct {
	Name   string
	Params []string
	Body   Expr
	Env    *Env // definition environment; expansions are evaluated here
}

type Builtin struct {
	Name string
	Fn   func(args []Value) (Value, error)
}

// BudgetExceededError is returned when the step budget runs out before the
// expansion/evaluation closes. Chain holds the active macro call chain.
type BudgetExceededError struct {
	Chain []string
}

func (e *BudgetExceededError) Error() string {
	return fmt.Sprintf("macro: step budget exhausted, expansion unclosed (chain: %s)",
		strings.Join(e.Chain, " -> "))
}

// Interpreter evaluates programs with a bounded step budget and records the
// macro expansion call chain.
type Interpreter struct {
	budget int
	chain  []string // currently active macro expansions
	trace  []string // append-only log of every macro expansion, in order
	gensym int
}

// NewInterpreter creates an Interpreter allowed at most budget steps.
func NewInterpreter(budget int) *Interpreter {
	return &Interpreter{budget: budget}
}

// Trace returns the ordered log of macro names expanded so far.
func (in *Interpreter) Trace() []string {
	return append([]string(nil), in.trace...)
}

func (in *Interpreter) step() error {
	if in.budget <= 0 {
		return &BudgetExceededError{Chain: append([]string(nil), in.chain...)}
	}
	in.budget--
	return nil
}

func (in *Interpreter) fresh(base string) string {
	in.gensym++
	return fmt.Sprintf("%s#%d", base, in.gensym)
}

// GlobalEnv returns a fresh top-level environment with arithmetic builtins.
func (in *Interpreter) GlobalEnv() *Env {
	env := NewEnv(nil)
	intBin := func(name string, f func(a, b int64) Value) {
		env.Define(name, &Builtin{Name: name, Fn: func(args []Value) (Value, error) {
			if len(args) != 2 {
				return nil, fmt.Errorf("%s: want 2 arguments, got %d", name, len(args))
			}
			a, ok := args[0].(Int)
			if !ok {
				return nil, fmt.Errorf("%s: first argument is not an integer", name)
			}
			b, ok := args[1].(Int)
			if !ok {
				return nil, fmt.Errorf("%s: second argument is not an integer", name)
			}
			return f(int64(a), int64(b)), nil
		}})
	}
	intBin("+", func(a, b int64) Value { return Int(a + b) })
	intBin("-", func(a, b int64) Value { return Int(a - b) })
	intBin("*", func(a, b int64) Value { return Int(a * b) })
	intBin("=", func(a, b int64) Value { return Bool(a == b) })
	intBin("<", func(a, b int64) Value { return Bool(a < b) })
	env.Define("not", &Builtin{Name: "not", Fn: func(args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("not: want 1 argument, got %d", len(args))
		}
		return Bool(!truthy(args[0])), nil
	}})
	return env
}

// Run parses and evaluates all top-level expressions in src and returns the
// last value.
func (in *Interpreter) Run(src string) (Value, error) {
	exprs, err := Parse(src)
	if err != nil {
		return nil, err
	}
	env := in.GlobalEnv()
	var v Value = Bool(false)
	for _, e := range exprs {
		v, err = in.Eval(e, env)
		if err != nil {
			return nil, err
		}
	}
	return v, nil
}

func truthy(v Value) bool {
	if b, ok := v.(Bool); ok {
		return bool(b)
	}
	return true
}

// Eval evaluates e in env, consuming one budget step per node.
func (in *Interpreter) Eval(e Expr, env *Env) (Value, error) {
	if err := in.step(); err != nil {
		return nil, err
	}
	switch x := e.(type) {
	case Int, Bool:
		return x, nil
	case Symbol:
		v, ok := env.Lookup(string(x))
		if !ok {
			return nil, fmt.Errorf("macro: unbound symbol %q", string(x))
		}
		return v, nil
	case List:
		return in.evalList(x, env)
	default:
		return nil, fmt.Errorf("macro: cannot evaluate %s", String(e))
	}
}

func (in *Interpreter) evalList(x List, env *Env) (Value, error) {
	if len(x) == 0 {
		return nil, fmt.Errorf("macro: cannot evaluate empty list")
	}
	if head, ok := x[0].(Symbol); ok {
		switch string(head) {
		case "quote":
			if len(x) != 2 {
				return nil, fmt.Errorf("macro: quote expects 1 argument")
			}
			return x[1], nil
		case "if":
			if len(x) != 4 {
				return nil, fmt.Errorf("macro: if expects 3 arguments")
			}
			c, err := in.Eval(x[1], env)
			if err != nil {
				return nil, err
			}
			if truthy(c) {
				return in.Eval(x[2], env)
			}
			return in.Eval(x[3], env)
		case "define":
			if len(x) != 3 {
				return nil, fmt.Errorf("macro: define expects 2 arguments")
			}
			name, ok := x[1].(Symbol)
			if !ok {
				return nil, fmt.Errorf("macro: define name must be a symbol")
			}
			v, err := in.Eval(x[2], env)
			if err != nil {
				return nil, err
			}
			env.Define(string(name), v)
			return v, nil
		case "lambda":
			if len(x) != 3 {
				return nil, fmt.Errorf("macro: lambda expects parameters and body")
			}
			params, err := paramNames(x[1])
			if err != nil {
				return nil, err
			}
			return &Closure{Params: params, Body: x[2], Env: env}, nil
		case "let":
			return in.evalLet(x, env)
		case "begin":
			var v Value = Bool(false)
			for _, e := range x[1:] {
				var err error
				v, err = in.Eval(e, env)
				if err != nil {
					return nil, err
				}
			}
			return v, nil
		case "defmacro":
			if len(x) != 4 {
				return nil, fmt.Errorf("macro: defmacro expects name, parameters and body")
			}
			name, ok := x[1].(Symbol)
			if !ok {
				return nil, fmt.Errorf("macro: defmacro name must be a symbol")
			}
			params, err := paramNames(x[2])
			if err != nil {
				return nil, err
			}
			m := &Macro{Name: string(name), Params: params, Body: x[3], Env: env}
			env.Define(string(name), m)
			return m, nil
		}
	}
	fn, err := in.Eval(x[0], env)
	if err != nil {
		return nil, err
	}
	switch f := fn.(type) {
	case *Macro:
		return in.applyMacro(f, x[1:], env)
	case *Closure:
		args, err := in.evalArgs(x[1:], env)
		if err != nil {
			return nil, err
		}
		if len(args) != len(f.Params) {
			return nil, fmt.Errorf("macro: closure wants %d arguments, got %d", len(f.Params), len(args))
		}
		callEnv := NewEnv(f.Env)
		for i, p := range f.Params {
			callEnv.Define(p, args[i])
		}
		return in.Eval(f.Body, callEnv)
	case *Builtin:
		args, err := in.evalArgs(x[1:], env)
		if err != nil {
			return nil, err
		}
		return f.Fn(args)
	default:
		return nil, fmt.Errorf("macro: not callable: %s", String(fn.(Expr)))
	}
}

func (in *Interpreter) evalLet(x List, env *Env) (Value, error) {
	if len(x) != 3 {
		return nil, fmt.Errorf("macro: let expects bindings and body")
	}
	bindings, ok := x[1].(List)
	if !ok {
		return nil, fmt.Errorf("macro: let bindings must be a list")
	}
	letEnv := NewEnv(env)
	for _, b := range bindings {
		pair, ok := b.(List)
		if !ok || len(pair) != 2 {
			return nil, fmt.Errorf("macro: malformed let binding")
		}
		name, ok := pair[0].(Symbol)
		if !ok {
			return nil, fmt.Errorf("macro: let binding name must be a symbol")
		}
		// Initializers see the outer environment (parallel let, not let*).
		v, err := in.Eval(pair[1], env)
		if err != nil {
			return nil, err
		}
		letEnv.Define(string(name), v)
	}
	return in.Eval(x[2], letEnv)
}

func (in *Interpreter) evalArgs(exprs []Expr, env *Env) ([]Value, error) {
	args := make([]Value, len(exprs))
	for i, e := range exprs {
		v, err := in.Eval(e, env)
		if err != nil {
			return nil, err
		}
		args[i] = v
	}
	return args, nil
}

// applyMacro evaluates the arguments in the caller's environment first, then
// expands the macro hygienically, then evaluates the expansion in the macro's
// definition environment so caller locals are never captured.
func (in *Interpreter) applyMacro(m *Macro, argExprs []Expr, callEnv *Env) (Value, error) {
	if len(argExprs) != len(m.Params) {
		return nil, fmt.Errorf("macro %s: wants %d arguments, got %d", m.Name, len(m.Params), len(argExprs))
	}
	args := make([]Value, len(argExprs))
	for i, ae := range argExprs {
		v, err := in.Eval(ae, callEnv) // arguments evaluated in the call environment
		if err != nil {
			return nil, err
		}
		args[i] = v
	}
	in.chain = append(in.chain, m.Name)
	in.trace = append(in.trace, m.Name)
	defer func() { in.chain = in.chain[:len(in.chain)-1] }()
	expansion, err := in.expand(m, args)
	if err != nil {
		return nil, err
	}
	return in.Eval(expansion, m.Env)
}

// expand substitutes parameter values into the template and renames every
// binder the template introduces (lambda/let) to a fresh name, so expansion
// bindings can never collide with caller locals.
func (in *Interpreter) expand(m *Macro, args []Value) (Expr, error) {
	if err := in.step(); err != nil {
		return nil, err
	}
	subst := make(map[string]Expr, len(m.Params))
	for i, p := range m.Params {
		lit, err := valueToExpr(args[i])
		if err != nil {
			return nil, fmt.Errorf("macro %s: %w", m.Name, err)
		}
		subst[p] = lit
	}
	return in.hygienic(m.Body, subst, map[string]string{}), nil
}

func valueToExpr(v Value) (Expr, error) {
	switch x := v.(type) {
	case Int:
		return x, nil
	case Bool:
		return x, nil
	case Symbol:
		return List{Symbol("quote"), x}, nil
	case List:
		return List{Symbol("quote"), x}, nil
	default:
		return nil, fmt.Errorf("cannot inject value of type %T into expansion", v)
	}
}

func (in *Interpreter) hygienic(e Expr, subst map[string]Expr, renames map[string]string) Expr {
	switch x := e.(type) {
	case Symbol:
		s := string(x)
		if r, ok := renames[s]; ok {
			return Symbol(r)
		}
		if sub, ok := subst[s]; ok {
			return sub
		}
		return x
	case List:
		if len(x) == 0 {
			return x
		}
		if head, ok := x[0].(Symbol); ok {
			switch string(head) {
			case "quote":
				return x
			case "lambda":
				if len(x) != 3 {
					return x
				}
				params, err := paramNames(x[1])
				if err != nil {
					return x
				}
				ns, nr := in.renameBinders(params, subst, renames)
				newParams := make(List, len(params))
				for i, p := range params {
					newParams[i] = Symbol(nr[p])
				}
				return List{head, newParams, in.hygienic(x[2], ns, nr)}
			case "let":
				if len(x) != 3 {
					return x
				}
				bindings, ok := x[1].(List)
				if !ok {
					return x
				}
				names := make([]string, 0, len(bindings))
				for _, b := range bindings {
					pair, ok := b.(List)
					if !ok || len(pair) != 2 {
						return x
					}
					nm, ok := pair[0].(Symbol)
					if !ok {
						return x
					}
					names = append(names, string(nm))
				}
				ns, nr := in.renameBinders(names, subst, renames)
				newBindings := make(List, len(bindings))
				for i, b := range bindings {
					pair := b.(List)
					nm := string(pair[0].(Symbol))
					// Initializers belong to the outer scope.
					newBindings[i] = List{Symbol(nr[nm]), in.hygienic(pair[1], subst, renames)}
				}
				return List{head, newBindings, in.hygienic(x[2], ns, nr)}
			}
		}
		out := make(List, len(x))
		for i, el := range x {
			out[i] = in.hygienic(el, subst, renames)
		}
		return out
	default:
		return x
	}
}

// renameBinders returns copies of subst/renames where each binder name is
// removed from the substitution map and mapped to a fresh gensym name.
func (in *Interpreter) renameBinders(names []string, subst map[string]Expr, renames map[string]string) (map[string]Expr, map[string]string) {
	ns := make(map[string]Expr, len(subst))
	for k, v := range subst {
		ns[k] = v
	}
	nr := make(map[string]string, len(renames)+len(names))
	for k, v := range renames {
		nr[k] = v
	}
	for _, n := range names {
		delete(ns, n)
		nr[n] = in.fresh(n)
	}
	return ns, nr
}

func paramNames(e Expr) ([]string, error) {
	lst, ok := e.(List)
	if !ok {
		return nil, fmt.Errorf("macro: parameter list must be a list")
	}
	names := make([]string, len(lst))
	for i, p := range lst {
		s, ok := p.(Symbol)
		if !ok {
			return nil, fmt.Errorf("macro: parameter must be a symbol")
		}
		names[i] = string(s)
	}
	return names, nil
}
