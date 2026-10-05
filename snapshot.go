package interp

import (
	"bytes"
	"encoding/gob"
)

// Serializable mirror of Machine. Environments and closures form cycles
// (a recursive closure captures the environment that binds it), which gob
// cannot encode directly, so they are interned into ID tables.
type snap struct {
	Ctl      *Node
	Val      *sValue
	Ret      bool
	Env      int
	Stack    []sFrame
	Hnd      []sHandler
	Unw      *sUnwind
	Out      []string
	Steps    int64
	MaxStack int
	Done     bool
	Err      string
	Envs     []sEnv
	Clos     []sClosure
}

type sEnv struct {
	Vars   map[string]*sValue
	Parent int
}

type sClosure struct {
	Name   string
	Params []string
	Body   []*Node
	Env    int
}

type sValue struct {
	Kind string // "nil","int","str","bool","sym","builtin","closure","pair"
	I    int64
	S    string
	B    bool
	Cl   int
	Car  *sValue
	Cdr  *sValue
}

type sFrame struct {
	Kind      FrameKind
	Env       int
	Exprs     []*Node
	Body      []*Node
	Vals      []*sValue
	Names     []string
	Name      string
	Fn        *sValue
	Saved     *sValue
	Started   bool
	Unwinding bool
	PopH      bool
}

type sHandler struct {
	Param    string
	Body     []*Node
	Env      int
	StackLen int
}

type sUnwind struct {
	Value    *sValue
	StackLen int
	Param    string
	Body     []*Node
	Env      int
	Uncaught bool
}

type serializer struct {
	envIDs map[*Env]int
	cloIDs map[*Closure]int
	sn     *snap
}

func (s *serializer) envID(e *Env) int {
	if e == nil {
		return -1
	}
	if id, ok := s.envIDs[e]; ok {
		return id
	}
	id := len(s.sn.Envs)
	s.envIDs[e] = id
	s.sn.Envs = append(s.sn.Envs, sEnv{}) // reserve before recursing (cycles)
	se := sEnv{Vars: map[string]*sValue{}, Parent: s.envID(e.Parent)}
	for k, v := range e.Vars {
		se.Vars[k] = s.val(v)
	}
	s.sn.Envs[id] = se
	return id
}

func (s *serializer) cloID(c *Closure) int {
	if id, ok := s.cloIDs[c]; ok {
		return id
	}
	id := len(s.sn.Clos)
	s.cloIDs[c] = id
	s.sn.Clos = append(s.sn.Clos, sClosure{}) // reserve before recursing
	s.sn.Clos[id] = sClosure{Name: c.Name, Params: c.Params, Body: c.Body, Env: s.envID(c.Env)}
	return id
}

func (s *serializer) val(v Value) *sValue {
	switch x := v.(type) {
	case nil:
		return &sValue{Kind: "nil"}
	case int64:
		return &sValue{Kind: "int", I: x}
	case string:
		return &sValue{Kind: "str", S: x}
	case bool:
		return &sValue{Kind: "bool", B: x}
	case Symbol:
		return &sValue{Kind: "sym", S: string(x)}
	case *Builtin:
		return &sValue{Kind: "builtin", S: x.Name}
	case *Closure:
		return &sValue{Kind: "closure", Cl: s.cloID(x)}
	case *Pair:
		return &sValue{Kind: "pair", Car: s.val(x.Car), Cdr: s.val(x.Cdr)}
	}
	return &sValue{Kind: "nil"}
}

func (s *serializer) frame(f *Frame) sFrame {
	sf := sFrame{
		Kind: f.Kind, Env: s.envID(f.Env), Exprs: f.Exprs, Body: f.Body,
		Names: f.Names, Name: f.Name,
		Started: f.Started, Unwinding: f.Unwinding, PopH: f.PopH,
	}
	for _, v := range f.Vals {
		sf.Vals = append(sf.Vals, s.val(v))
	}
	if f.Fn != nil {
		sf.Fn = s.val(f.Fn)
	}
	if f.Saved != nil {
		sf.Saved = s.val(f.Saved)
	}
	return sf
}

// Snapshot serializes the full machine state (control, environments,
// continuation stack, handlers, output log) into bytes.
func (m *Machine) Snapshot() ([]byte, error) {
	s := &serializer{envIDs: map[*Env]int{}, cloIDs: map[*Closure]int{}, sn: &snap{Env: -1}}
	sn := s.sn
	sn.Ctl = m.Ctl
	sn.Val = s.val(m.Val)
	sn.Ret = m.Ret
	sn.Env = s.envID(m.Env)
	for _, f := range m.Stack {
		sn.Stack = append(sn.Stack, s.frame(f))
	}
	for _, h := range m.Hnd {
		sn.Hnd = append(sn.Hnd, sHandler{Param: h.Param, Body: h.Body, Env: s.envID(h.Env), StackLen: h.StackLen})
	}
	if m.Unw != nil {
		sn.Unw = &sUnwind{
			Value: s.val(m.Unw.Value), StackLen: m.Unw.StackLen,
			Param: m.Unw.Param, Body: m.Unw.Body, Env: s.envID(m.Unw.Env),
			Uncaught: m.Unw.Uncaught,
		}
	}
	sn.Out = m.Out
	sn.Steps = m.Steps
	sn.MaxStack = m.MaxStack
	sn.Done = m.Done
	sn.Err = m.Err
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(sn); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Restore rebuilds a machine from Snapshot bytes; it can be resumed with Run.
func Restore(data []byte) (*Machine, error) {
	var sn snap
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&sn); err != nil {
		return nil, err
	}
	envs := make([]*Env, len(sn.Envs))
	for i := range envs {
		envs[i] = &Env{}
	}
	clos := make([]*Closure, len(sn.Clos))
	for i := range clos {
		clos[i] = &Closure{}
	}
	var val func(sv *sValue) Value
	val = func(sv *sValue) Value {
		if sv == nil {
			return nil
		}
		switch sv.Kind {
		case "int":
			return sv.I
		case "str":
			return sv.S
		case "bool":
			return sv.B
		case "sym":
			return Symbol(sv.S)
		case "builtin":
			return &Builtin{Name: sv.S}
		case "closure":
			return clos[sv.Cl]
		case "pair":
			return &Pair{Car: val(sv.Car), Cdr: val(sv.Cdr)}
		}
		return nil
	}
	for i, se := range sn.Envs {
		envs[i].Vars = make(map[string]Value, len(se.Vars))
		for k, sv := range se.Vars {
			envs[i].Vars[k] = val(sv)
		}
		if se.Parent >= 0 {
			envs[i].Parent = envs[se.Parent]
		}
	}
	for i, sc := range sn.Clos {
		clos[i].Name = sc.Name
		clos[i].Params = sc.Params
		clos[i].Body = sc.Body
		if sc.Env >= 0 {
			clos[i].Env = envs[sc.Env]
		}
	}
	envAt := func(id int) *Env {
		if id < 0 {
			return nil
		}
		return envs[id]
	}
	m := &Machine{
		Ctl: sn.Ctl, Val: val(sn.Val), Ret: sn.Ret, Env: envAt(sn.Env),
		Out: sn.Out, Steps: sn.Steps, MaxStack: sn.MaxStack, Done: sn.Done, Err: sn.Err,
	}
	for _, sf := range sn.Stack {
		f := &Frame{
			Kind: sf.Kind, Env: envAt(sf.Env), Exprs: sf.Exprs, Body: sf.Body,
			Names: sf.Names, Name: sf.Name,
			Started: sf.Started, Unwinding: sf.Unwinding, PopH: sf.PopH,
		}
		for _, sv := range sf.Vals {
			f.Vals = append(f.Vals, val(sv))
		}
		if sf.Fn != nil {
			f.Fn = val(sf.Fn)
		}
		if sf.Saved != nil {
			f.Saved = val(sf.Saved)
		}
		m.Stack = append(m.Stack, f)
	}
	for _, sh := range sn.Hnd {
		m.Hnd = append(m.Hnd, &Handler{Param: sh.Param, Body: sh.Body, Env: envAt(sh.Env), StackLen: sh.StackLen})
	}
	if sn.Unw != nil {
		m.Unw = &Unwind{
			Value: val(sn.Unw.Value), StackLen: sn.Unw.StackLen,
			Param: sn.Unw.Param, Body: sn.Unw.Body, Env: envAt(sn.Unw.Env),
			Uncaught: sn.Unw.Uncaught,
		}
	}
	return m, nil
}
