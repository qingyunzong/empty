package interp

import (
	"fmt"
	"strings"
)

type builtinFn func(ctx Logger, args []Value) (Value, error)

func asInt(v Value) (int64, error) {
	i, ok := v.(int64)
	if !ok {
		return 0, fmt.Errorf("expected integer, got %s", showValue(v))
	}
	return i, nil
}

func asInts(args []Value) ([]int64, error) {
	out := make([]int64, len(args))
	for i, a := range args {
		v, err := asInt(a)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func intCmp(name string, ok func(a, b int64) bool) builtinFn {
	return func(_ Logger, args []Value) (Value, error) {
		ns, err := asInts(args)
		if err != nil {
			return nil, err
		}
		if len(ns) < 2 {
			return nil, fmt.Errorf("%s: need at least 2 arguments", name)
		}
		for i := 0; i+1 < len(ns); i++ {
			if !ok(ns[i], ns[i+1]) {
				return false, nil
			}
		}
		return true, nil
	}
}

var builtins = map[string]builtinFn{
	"+": func(_ Logger, args []Value) (Value, error) {
		ns, err := asInts(args)
		if err != nil {
			return nil, err
		}
		var sum int64
		for _, n := range ns {
			sum += n
		}
		return sum, nil
	},
	"*": func(_ Logger, args []Value) (Value, error) {
		ns, err := asInts(args)
		if err != nil {
			return nil, err
		}
		prod := int64(1)
		for _, n := range ns {
			prod *= n
		}
		return prod, nil
	},
	"-": func(_ Logger, args []Value) (Value, error) {
		ns, err := asInts(args)
		if err != nil {
			return nil, err
		}
		if len(ns) == 0 {
			return nil, fmt.Errorf("-: need at least 1 argument")
		}
		if len(ns) == 1 {
			return -ns[0], nil
		}
		r := ns[0]
		for _, n := range ns[1:] {
			r -= n
		}
		return r, nil
	},
	"=":  intCmp("=", func(a, b int64) bool { return a == b }),
	"<":  intCmp("<", func(a, b int64) bool { return a < b }),
	"<=": intCmp("<=", func(a, b int64) bool { return a <= b }),
	">":  intCmp(">", func(a, b int64) bool { return a > b }),
	">=": intCmp(">=", func(a, b int64) bool { return a >= b }),
	"not": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("not: need 1 argument")
		}
		return !truthy(args[0]), nil
	},
	"eq?": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 2 {
			return nil, fmt.Errorf("eq?: need 2 arguments")
		}
		return valuesEqual(args[0], args[1]), nil
	},
	"cons": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 2 {
			return nil, fmt.Errorf("cons: need 2 arguments")
		}
		return &Pair{Car: args[0], Cdr: args[1]}, nil
	},
	"car": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("car: need 1 argument")
		}
		p, ok := args[0].(*Pair)
		if !ok {
			return nil, fmt.Errorf("car: not a pair: %s", showValue(args[0]))
		}
		return p.Car, nil
	},
	"cdr": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("cdr: need 1 argument")
		}
		p, ok := args[0].(*Pair)
		if !ok {
			return nil, fmt.Errorf("cdr: not a pair: %s", showValue(args[0]))
		}
		return p.Cdr, nil
	},
	"pair?": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("pair?: need 1 argument")
		}
		_, ok := args[0].(*Pair)
		return ok, nil
	},
	"nil?": func(_ Logger, args []Value) (Value, error) {
		if len(args) != 1 {
			return nil, fmt.Errorf("nil?: need 1 argument")
		}
		return args[0] == nil, nil
	},
	"list": func(_ Logger, args []Value) (Value, error) {
		var v Value
		for i := len(args) - 1; i >= 0; i-- {
			v = &Pair{Car: args[i], Cdr: v}
		}
		return v, nil
	},
	"emit": func(ctx Logger, args []Value) (Value, error) {
		parts := make([]string, len(args))
		for i, a := range args {
			parts[i] = showValue(a)
		}
		ctx.Log(strings.Join(parts, " "))
		return nil, nil
	},
}
