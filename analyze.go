package effectcheck

import (
	"fmt"
	"sort"
)

// Diagnostic is a problem reported by the checker.
type Diagnostic struct {
	Func    string
	Region  string
	Message string
}

// Result is the outcome of an analysis: per-function effect summaries plus
// diagnostics (e.g. local regions escaping via return).
type Result struct {
	Summaries   map[string]*Summary
	Diagnostics []Diagnostic
}

// localSummary computes the effects produced directly by f's own statements,
// ignoring calls.
func localSummary(f *Func) *Summary {
	s := NewSummary()
	for _, st := range f.Body {
		switch st.Kind {
		case ReadStmt:
			s.Reads[Effect{Region: st.Region, Path: st.Path}] = struct{}{}
		case WriteStmt:
			s.Writes[Effect{Region: st.Region, Path: st.Path}] = struct{}{}
		case ThrowStmt:
			s.Throws[Throw{Exc: st.Exc, Path: st.Path}] = struct{}{}
		case ReturnStmt:
			if st.Region != "" {
				s.Returns[st.Region] = struct{}{}
			}
		}
	}
	return s
}

// absorb merges the observable effects of callee (with summary cs) into s.
// Effects on regions local to the callee are hidden from the caller. It
// reports whether s changed.
func absorb(s *Summary, callee *Func, cs *Summary) bool {
	changed := false
	for e := range cs.Reads {
		if callee.IsLocal(e.Region) {
			continue
		}
		if _, ok := s.Reads[e]; !ok {
			s.Reads[e] = struct{}{}
			changed = true
		}
	}
	for e := range cs.Writes {
		if callee.IsLocal(e.Region) {
			continue
		}
		if _, ok := s.Writes[e]; !ok {
			s.Writes[e] = struct{}{}
			changed = true
		}
	}
	for t := range cs.Throws {
		if _, ok := s.Throws[t]; !ok {
			s.Throws[t] = struct{}{}
			changed = true
		}
	}
	return changed
}

// Analyze runs a full effect analysis of the program. Recursive and mutually
// recursive calls are handled by iterating the summary equations to their
// least fixed point; the domain is finite, so iteration always terminates.
func Analyze(p *Program) *Result {
	sums := make(map[string]*Summary, len(p.Funcs))
	for name, f := range p.Funcs {
		sums[name] = localSummary(f)
	}
	for changed := true; changed; {
		changed = false
		for name, f := range p.Funcs {
			for _, calleeName := range p.callees(f) {
				callee, ok := p.Funcs[calleeName]
				if !ok {
					continue
				}
				if absorb(sums[name], callee, sums[calleeName]) {
					changed = true
				}
			}
		}
	}
	return &Result{Summaries: sums, Diagnostics: diagnostics(p, sums)}
}

// diagnostics reports local regions escaping via return and calls to unknown
// functions, in a deterministic order.
func diagnostics(p *Program, sums map[string]*Summary) []Diagnostic {
	var diags []Diagnostic
	for name, f := range p.Funcs {
		for _, region := range SortedStrings(sums[name].Returns) {
			if f.IsLocal(region) {
				diags = append(diags, Diagnostic{
					Func:   name,
					Region: region,
					Message: fmt.Sprintf("local region %q escapes function %q via return",
						region, name),
				})
			}
		}
		for _, callee := range p.callees(f) {
			if _, ok := p.Funcs[callee]; !ok {
				diags = append(diags, Diagnostic{
					Func:    name,
					Message: fmt.Sprintf("function %q calls unknown function %q", name, callee),
				})
			}
		}
	}
	sort.Slice(diags, func(i, j int) bool {
		if diags[i].Func != diags[j].Func {
			return diags[i].Func < diags[j].Func
		}
		return diags[i].Message < diags[j].Message
	})
	return diags
}

// Equal reports whether two results are identical.
func (r *Result) Equal(o *Result) bool {
	if len(r.Summaries) != len(o.Summaries) || len(r.Diagnostics) != len(o.Diagnostics) {
		return false
	}
	for name, s := range r.Summaries {
		os, ok := o.Summaries[name]
		if !ok || !s.equal(os) {
			return false
		}
	}
	for i, d := range r.Diagnostics {
		if d != o.Diagnostics[i] {
			return false
		}
	}
	return true
}
