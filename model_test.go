package statever

import (
	"strings"
	"testing"
)

func parse(t *testing.T, js string) *Model {
	t.Helper()
	m, err := ParseModel(strings.NewReader(js))
	if err != nil {
		t.Fatalf("ParseModel: %v", err)
	}
	return m
}

func parseErr(t *testing.T, js string) error {
	t.Helper()
	_, err := ParseModel(strings.NewReader(js))
	if err == nil {
		t.Fatalf("expected error, got none")
	}
	return err
}

func TestLimitsEnforced(t *testing.T) {
	// 9 states exceeds the limit of 8.
	parseErr(t, `{"states":["a","b","c","d","e","f","g","h","i"],"initial":"a","events":["x"],"transitions":[],"bad":[],"budget":1}`)
	// 6 events exceeds the limit of 5.
	parseErr(t, `{"states":["a"],"initial":"a","events":["e1","e2","e3","e4","e5","e6"],"transitions":[],"bad":[],"budget":1}`)
	// Budget 11 exceeds the limit of 10.
	parseErr(t, `{"states":["a"],"initial":"a","events":["x"],"transitions":[],"bad":[],"budget":11}`)
	// Negative budget rejected.
	parseErr(t, `{"states":["a"],"initial":"a","events":["x"],"transitions":[],"bad":[],"budget":-1}`)
	// Undeclared references rejected.
	parseErr(t, `{"states":["a"],"initial":"zzz","events":["x"],"transitions":[],"bad":[],"budget":1}`)
	parseErr(t, `{"states":["a"],"initial":"a","events":["x"],"transitions":[{"from":"a","event":"nope","to":"a"}],"bad":[],"budget":1}`)
	parseErr(t, `{"states":["a"],"initial":"a","events":["x"],"transitions":[],"bad":["ghost"],"budget":1}`)
}

func TestValidModelAndDefaults(t *testing.T) {
	m := parse(t, `{"states":["s0","s1"],"initial":"s0","events":["a","b"],
		"transitions":[{"from":"s0","event":"a","to":"s1"}],"bad":["s1"]}`)
	if m.Budget != MaxBudget {
		t.Fatalf("default budget = %d, want %d", m.Budget, MaxBudget)
	}
	if m.NumStates() != 2 || m.NumEvents() != 2 {
		t.Fatalf("got %d states, %d events", m.NumStates(), m.NumEvents())
	}
	if !m.Enabled(m.InitialIndex(), 0) || m.Enabled(m.InitialIndex(), 1) {
		t.Fatalf("enabled map wrong")
	}
}

// chainModel builds s0 -a-> s1 -a-> ... -a-> s{n-1} with s{n-1} bad.
func chainModel(t *testing.T, n, budget int) *Model {
	t.Helper()
	var states, trans []string
	for i := 0; i < n; i++ {
		states = append(states, `"`+string(rune('a'+i))+`"`)
		if i+1 < n {
			trans = append(trans, `{"from":"`+string(rune('a'+i))+`","event":"go","to":"`+string(rune('a'+i+1))+`"}`)
		}
	}
	js := `{"states":[` + strings.Join(states, ",") + `],"initial":"a","events":["go"],` +
		`"transitions":[` + strings.Join(trans, ",") + `],"bad":["` + string(rune('a'+n-1)) + `"],` +
		`"budget":` + itoa(budget) + `}`
	return parse(t, js)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	if i == 10 {
		return "10"
	}
	return string(rune('0' + i))
}
