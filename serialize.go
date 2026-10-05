package interp

import "encoding/json"

// Serialization of a suspended (or finished) machine. Environments and
// closures form arbitrary graphs — recursive closures capture the
// environment that binds them — so they are encoded through ID tables and
// reconstructed with fixups on load. AST nodes are plain trees and ride
// along directly.

type serValue struct {
	Kind VKind  `json:"kind"`
	Num  int64  `json:"num,omitempty"`
	Str  string `json:"str,omitempty"`
	Clo  int    `json:"clo,omitempty"` // index into closures table, -1 unless VClosure
	Prim string `json:"prim,omitempty"`
}

type serEnv struct {
	Vars   map[string]serValue `json:"vars"`
	Parent int                 `json:"parent"` // -1 for none
}

type serClosure struct {
	Name   string   `json:"name,omitempty"`
	Params []string `json:"params,omitempty"`
	Body   []*Node  `json:"body"`
	Env    int      `json:"env"`
}

type serFrame struct {
	Kind frameKind `json:"kind"`
	Env  int       `json:"env"` // -1 for none

	Then *Node   `json:"then,omitempty"`
	Els  *Node   `json:"els,omitempty"`
	Rest []*Node `json:"rest,omitempty"`
	Args []*Node `json:"args,omitempty"`

	Fun  serValue   `json:"fun,omitempty"`
	Done []serValue `json:"done,omitempty"`
	Todo []*Node    `json:"todo,omitempty"`

	Cleanup []*Node  `json:"cleanup,omitempty"`
	Saved   serValue `json:"saved,omitempty"`
	Exc     serValue `json:"exc,omitempty"`

	Param string  `json:"param,omitempty"`
	Body  []*Node `json:"body,omitempty"`
}

type serMachine struct {
	Expr     *Node        `json:"expr,omitempty"`
	Val      serValue     `json:"val"`
	HasVal   bool         `json:"hasVal"`
	Env      int          `json:"env"`
	Stack    []serFrame   `json:"stack"`
	Steps    int64        `json:"steps"`
	Log      []string     `json:"log"`
	MaxDepth int          `json:"maxDepth"`
	Status   Status       `json:"status"`
	Result   serValue     `json:"result"`
	Err      string       `json:"err,omitempty"`
	Envs     []serEnv     `json:"envs"`
	Closures []serClosure `json:"closures"`
}

type encoder struct {
	envIDs   map[*Env]int
	cloIDs   map[*Closure]int
	envs     []serEnv
	closures []serClosure
}

func (e *encoder) envID(env *Env) int {
	if env == nil {
		return -1
	}
	if id, ok := e.envIDs[env]; ok {
		return id
	}
	id := len(e.envs)
	e.envIDs[env] = id
	e.envs = append(e.envs, serEnv{Parent: -1}) // placeholder for cycles
	se := serEnv{Vars: map[string]serValue{}, Parent: e.envID(env.Parent)}
	for k, v := range env.Vars {
		se.Vars[k] = e.value(v)
	}
	e.envs[id] = se
	return id
}

func (e *encoder) cloID(c *Closure) int {
	if id, ok := e.cloIDs[c]; ok {
		return id
	}
	id := len(e.closures)
	e.cloIDs[c] = id
	e.closures = append(e.closures, serClosure{}) // placeholder for cycles
	e.closures[id] = serClosure{
		Name: c.Name, Params: c.Params, Body: c.Body, Env: e.envID(c.Env),
	}
	return id
}

func (e *encoder) value(v Value) serValue {
	sv := serValue{Kind: v.Kind, Num: v.Num, Str: v.Str, Clo: -1, Prim: v.Prim}
	if v.Kind == VClosure {
		sv.Clo = e.cloID(v.Clo)
	}
	return sv
}

func (e *encoder) frame(f frame) serFrame {
	sf := serFrame{
		Kind: f.kind, Env: e.envID(f.env),
		Then: f.then, Els: f.els, Rest: f.rest, Args: f.args,
		Fun: e.value(f.fun), Todo: f.todo,
		Cleanup: f.cleanup, Saved: e.value(f.saved), Exc: e.value(f.exc),
		Param: f.param, Body: f.body,
	}
	for _, v := range f.done {
		sf.Done = append(sf.Done, e.value(v))
	}
	return sf
}

// MarshalJSON encodes the full machine state, including the continuation.
func (m *Machine) MarshalJSON() ([]byte, error) {
	e := &encoder{envIDs: map[*Env]int{}, cloIDs: map[*Closure]int{}}
	sm := serMachine{
		Expr: m.expr, Val: e.value(m.val), HasVal: m.hasVal,
		Env: e.envID(m.env), Steps: m.Steps, Log: m.Log,
		MaxDepth: m.MaxDepth, Status: m.Status,
		Result: e.value(m.Result), Err: m.Err,
	}
	for _, f := range m.stack {
		sm.Stack = append(sm.Stack, e.frame(f))
	}
	sm.Envs = e.envs
	sm.Closures = e.closures
	return json.Marshal(sm)
}

type decoder struct {
	envs []*Env
	clos []*Closure
}

func (d *decoder) value(sv serValue) Value {
	v := Value{Kind: sv.Kind, Num: sv.Num, Str: sv.Str, Prim: sv.Prim}
	if sv.Kind == VClosure && sv.Clo >= 0 {
		v.Clo = d.clos[sv.Clo]
	}
	return v
}

// UnmarshalJSON restores a machine previously encoded with MarshalJSON.
// The restored machine is behaviorally identical: resuming it produces the
// same values and log entries as resuming the original.
func (m *Machine) UnmarshalJSON(data []byte) error {
	var sm serMachine
	if err := json.Unmarshal(data, &sm); err != nil {
		return err
	}
	d := &decoder{
		envs: make([]*Env, len(sm.Envs)),
		clos: make([]*Closure, len(sm.Closures)),
	}
	for i := range d.envs {
		d.envs[i] = &Env{}
	}
	for i := range d.clos {
		d.clos[i] = &Closure{}
	}
	for i, se := range sm.Envs {
		env := d.envs[i]
		env.Vars = make(map[string]Value, len(se.Vars))
		for k, sv := range se.Vars {
			env.Vars[k] = d.value(sv)
		}
		if se.Parent >= 0 {
			env.Parent = d.envs[se.Parent]
		}
	}
	for i, sc := range sm.Closures {
		c := d.clos[i]
		c.Name, c.Params, c.Body = sc.Name, sc.Params, sc.Body
		if sc.Env >= 0 {
			c.Env = d.envs[sc.Env]
		}
	}
	envAt := func(id int) *Env {
		if id < 0 {
			return nil
		}
		return d.envs[id]
	}
	m.expr = sm.Expr
	m.val = d.value(sm.Val)
	m.hasVal = sm.HasVal
	m.env = envAt(sm.Env)
	m.Steps = sm.Steps
	m.Log = sm.Log
	m.MaxDepth = sm.MaxDepth
	m.Status = sm.Status
	m.Result = d.value(sm.Result)
	m.Err = sm.Err
	m.stack = m.stack[:0]
	for _, sf := range sm.Stack {
		f := frame{
			kind: sf.Kind, env: envAt(sf.Env),
			then: sf.Then, els: sf.Els, rest: sf.Rest, args: sf.Args,
			fun: d.value(sf.Fun), todo: sf.Todo,
			cleanup: sf.Cleanup, saved: d.value(sf.Saved), exc: d.value(sf.Exc),
			param: sf.Param, body: sf.Body,
		}
		for _, sv := range sf.Done {
			f.done = append(f.done, d.value(sv))
		}
		m.stack = append(m.stack, f)
	}
	return nil
}
