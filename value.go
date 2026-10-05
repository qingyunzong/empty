package interp

import (
	"fmt"
	"strings"
)

// VKind tags the payload of a Value.
type VKind int

const (
	VNil VKind = iota
	VBool
	VInt
	VStr
	VClosure
	VPrim
)

// Value is a tagged union; using a struct (not an interface) keeps the
// machine state straightforward to serialize.
type Value struct {
	Kind VKind
	Num  int64
	Str  string
	Clo  *Closure
	Prim string
}

// Closure is a lexical closure: parameter list, body, captured environment.
// Name, when set, binds the closure to itself inside its own environment
// (this creates an env<->closure cycle, which the serializer handles).
type Closure struct {
	Name   string
	Params []string
	Body   []*Node
	Env    *Env
}

// Env is a lexical scope frame chained to its parent.
type Env struct {
	Vars   map[string]Value
	Parent *Env
}

func (e *Env) lookup(name string) (Value, bool) {
	for ; e != nil; e = e.Parent {
		if v, ok := e.Vars[name]; ok {
			return v, true
		}
	}
	return Value{}, false
}

func extend(parent *Env, names []string, vals []Value) *Env {
	vars := make(map[string]Value, len(names))
	for i, n := range names {
		vars[n] = vals[i]
	}
	return &Env{Vars: vars, Parent: parent}
}

func boolVal(b bool) Value {
	if b {
		return Value{Kind: VBool, Num: 1}
	}
	return Value{Kind: VBool}
}

func truthy(v Value) bool {
	return !(v.Kind == VBool && v.Num == 0) && v.Kind != VNil
}

// Show renders a value for logs and results.
func Show(v Value) string {
	switch v.Kind {
	case VNil:
		return "nil"
	case VBool:
		if v.Num != 0 {
			return "true"
		}
		return "false"
	case VInt:
		return fmt.Sprintf("%d", v.Num)
	case VStr:
		return v.Str
	case VClosure:
		if v.Clo.Name != "" {
			return "<lambda " + v.Clo.Name + ">"
		}
		return "<lambda>"
	case VPrim:
		return "<prim " + v.Prim + ">"
	}
	return "?"
}

// Prims is the primitive procedure table. Primitives receive the output log
// so `log` can append to it; a returned error is raised as a catchable
// exception carrying the message string.
var Prims = map[string]func(log *[]string, args []Value) (Value, error){
	"+": arith2("+", func(a, b int64) (int64, error) { return a + b, nil }),
	"-": arith2("-", func(a, b int64) (int64, error) { return a - b, nil }),
	"*": arith2("*", func(a, b int64) (int64, error) { return a * b, nil }),
	"/": arith2("/", func(a, b int64) (int64, error) {
		if b == 0 {
			return 0, fmt.Errorf("division by zero")
		}
		return a / b, nil
	}),
	"=": cmp2("=", func(a, b int64) bool { return a == b }),
	"<": cmp2("<", func(a, b int64) bool { return a < b }),
	">": cmp2(">", func(a, b int64) bool { return a > b }),
	"not": func(log *[]string, args []Value) (Value, error) {
		if len(args) != 1 {
			return Value{}, fmt.Errorf("not: arity")
		}
		return boolVal(!truthy(args[0])), nil
	},
	"log": func(log *[]string, args []Value) (Value, error) {
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = Show(a)
		}
		*log = append(*log, strings.Join(parts, " "))
		return Value{Kind: VNil}, nil
	},
}

func arith2(name string, f func(a, b int64) (int64, error)) func(*[]string, []Value) (Value, error) {
	return func(_ *[]string, args []Value) (Value, error) {
		a, b, err := twoInts(name, args)
		if err != nil {
			return Value{}, err
		}
		r, err := f(a, b)
		if err != nil {
			return Value{}, err
		}
		return Value{Kind: VInt, Num: r}, nil
	}
}

func cmp2(name string, f func(a, b int64) bool) func(*[]string, []Value) (Value, error) {
	return func(_ *[]string, args []Value) (Value, error) {
		a, b, err := twoInts(name, args)
		if err != nil {
			return Value{}, err
		}
		return boolVal(f(a, b)), nil
	}
}

func twoInts(name string, args []Value) (int64, int64, error) {
	if len(args) != 2 || args[0].Kind != VInt || args[1].Kind != VInt {
		return 0, 0, fmt.Errorf("%s: expects two integers", name)
	}
	return args[0].Num, args[1].Num, nil
}
