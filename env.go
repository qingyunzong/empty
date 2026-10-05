package macro

import "fmt"

// Env is a lexical scope frame chained to its parent.
type Env struct {
	vars   map[Symbol]Value
	parent *Env
}

func NewEnv(parent *Env) *Env {
	return &Env{vars: map[Symbol]Value{}, parent: parent}
}

// NewGlobalEnv returns a root frame preloaded with builtins.
func NewGlobalEnv() *Env {
	e := NewEnv(nil)
	for name, fn := range builtins {
		e.vars[name] = fn
	}
	return e
}

func (e *Env) Define(s Symbol, v Value) { e.vars[s] = v }

func (e *Env) Lookup(s Symbol) (Value, bool) {
	for cur := e; cur != nil; cur = cur.parent {
		if v, ok := cur.vars[s]; ok {
			return v, true
		}
	}
	return nil, false
}

// Builtin is a primitive function.
type Builtin func(args []Value) (Value, error)

func arity(name string, args []Value, n int) error {
	if len(args) != n {
		return fmt.Errorf("%s: expected %d args, got %d", name, n, len(args))
	}
	return nil
}

func asInt(name string, v Value) (Int, error) {
	n, ok := v.(Int)
	if !ok {
		return 0, fmt.Errorf("%s: expected integer, got %v", name, v)
	}
	return n, nil
}

var builtins = map[Symbol]Builtin{
	"+": func(args []Value) (Value, error) {
		sum := Int(0)
		for _, a := range args {
			n, err := asInt("+", a)
			if err != nil {
				return nil, err
			}
			sum += n
		}
		return sum, nil
	},
	"-": func(args []Value) (Value, error) {
		if len(args) == 0 {
			return nil, fmt.Errorf("-: expected at least 1 arg")
		}
		first, err := asInt("-", args[0])
		if err != nil {
			return nil, err
		}
		if len(args) == 1 {
			return -first, nil
		}
		for _, a := range args[1:] {
			n, err := asInt("-", a)
			if err != nil {
				return nil, err
			}
			first -= n
		}
		return first, nil
	},
	"*": func(args []Value) (Value, error) {
		prod := Int(1)
		for _, a := range args {
			n, err := asInt("*", a)
			if err != nil {
				return nil, err
			}
			prod *= n
		}
		return prod, nil
	},
	"=": func(args []Value) (Value, error) {
		if err := arity("=", args, 2); err != nil {
			return nil, err
		}
		a, err := asInt("=", args[0])
		if err != nil {
			return nil, err
		}
		b, err := asInt("=", args[1])
		if err != nil {
			return nil, err
		}
		return Bool(a == b), nil
	},
	"<": func(args []Value) (Value, error) {
		if err := arity("<", args, 2); err != nil {
			return nil, err
		}
		a, err := asInt("<", args[0])
		if err != nil {
			return nil, err
		}
		b, err := asInt("<", args[1])
		if err != nil {
			return nil, err
		}
		return Bool(a < b), nil
	},
	"not": func(args []Value) (Value, error) {
		if err := arity("not", args, 1); err != nil {
			return nil, err
		}
		b, ok := args[0].(Bool)
		if !ok {
			return nil, fmt.Errorf("not: expected boolean, got %v", args[0])
		}
		return Bool(!b), nil
	},
	"list": func(args []Value) (Value, error) {
		return List(append([]Value(nil), args...)), nil
	},
	"car": func(args []Value) (Value, error) {
		if err := arity("car", args, 1); err != nil {
			return nil, err
		}
		l, ok := args[0].(List)
		if !ok || len(l) == 0 {
			return nil, fmt.Errorf("car: expected non-empty list, got %v", args[0])
		}
		return l[0], nil
	},
	"cdr": func(args []Value) (Value, error) {
		if err := arity("cdr", args, 1); err != nil {
			return nil, err
		}
		l, ok := args[0].(List)
		if !ok || len(l) == 0 {
			return nil, fmt.Errorf("cdr: expected non-empty list, got %v", args[0])
		}
		return l[1:], nil
	},
}
