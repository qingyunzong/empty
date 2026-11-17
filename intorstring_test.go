package formal

import (
	"encoding/json"
	"testing"
	"time"
)

func TestKubernetesPercentageRounding(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		desired     int
		surge       IntOrString
		unavailable IntOrString
		wantSurge   int
		wantUnavail int
		wantMin     int
		wantMax     int
	}{
		{
			name:        "small percentages round in opposite directions",
			desired:     3,
			surge:       Percent(10),
			unavailable: Percent(10),
			wantSurge:   1,
			wantUnavail: 0,
			wantMin:     3,
			wantMax:     4,
		},
		{
			name:        "quarter of ten",
			desired:     10,
			surge:       Percent(25),
			unavailable: Percent(25),
			wantSurge:   3,
			wantUnavail: 2,
			wantMin:     8,
			wantMax:     13,
		},
		{
			name:        "fraction of one",
			desired:     1,
			surge:       Percent(50),
			unavailable: Percent(50),
			wantSurge:   1,
			wantUnavail: 0,
			wantMin:     1,
			wantMax:     2,
		},
		{
			name:        "thirty three percent of seven",
			desired:     7,
			surge:       Percent(33),
			unavailable: Percent(33),
			wantSurge:   3,
			wantUnavail: 2,
			wantMin:     5,
			wantMax:     10,
		},
		{
			name:        "zero desired",
			desired:     0,
			surge:       Percent(25),
			unavailable: Percent(25),
			wantSurge:   0,
			wantUnavail: 0,
			wantMin:     0,
			wantMax:     0,
		},
		{
			name:        "all unavailable",
			desired:     4,
			surge:       Int(0),
			unavailable: Percent(100),
			wantSurge:   0,
			wantUnavail: 4,
			wantMin:     0,
			wantMax:     4,
		},
		{
			name:        "absolute values",
			desired:     5,
			surge:       Int(2),
			unavailable: Int(1),
			wantSurge:   2,
			wantUnavail: 1,
			wantMin:     4,
			wantMax:     7,
		},
		{
			name:        "surge can equal desired",
			desired:     2,
			surge:       Percent(100),
			unavailable: Percent(100),
			wantSurge:   2,
			wantUnavail: 2,
			wantMin:     0,
			wantMax:     4,
		},
		{
			name:        "just below one rounds up only for surge",
			desired:     11,
			surge:       Percent(9),
			unavailable: Percent(9),
			wantSurge:   1,
			wantUnavail: 0,
			wantMin:     11,
			wantMax:     12,
		},
		{
			name:        "one percent of one hundred",
			desired:     100,
			surge:       Percent(1),
			unavailable: Percent(1),
			wantSurge:   1,
			wantUnavail: 1,
			wantMin:     99,
			wantMax:     101,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			bounds, err := ResolvePolicy(Policy{
				DesiredReplicas: tt.desired,
				MaxSurge:        tt.surge,
				MaxUnavailable:  tt.unavailable,
			})
			if err != nil {
				t.Fatalf("ResolvePolicy() error = %v", err)
			}
			if bounds.MaxSurge != tt.wantSurge {
				t.Errorf("MaxSurge = %d, want %d", bounds.MaxSurge, tt.wantSurge)
			}
			if bounds.MaxUnavailable != tt.wantUnavail {
				t.Errorf("MaxUnavailable = %d, want %d", bounds.MaxUnavailable, tt.wantUnavail)
			}
			if bounds.MinAvailable != tt.wantMin {
				t.Errorf("MinAvailable = %d, want %d", bounds.MinAvailable, tt.wantMin)
			}
			if bounds.MaxTotal != tt.wantMax {
				t.Errorf("MaxTotal = %d, want %d", bounds.MaxTotal, tt.wantMax)
			}
		})
	}
}

func TestPolicyDefaultsToKubernetesQuarter(t *testing.T) {
	t.Parallel()

	bounds, err := ResolvePolicy(Policy{DesiredReplicas: 4})
	if err != nil {
		t.Fatalf("ResolvePolicy() error = %v", err)
	}
	if bounds.MaxSurge != 1 || bounds.MaxUnavailable != 1 {
		t.Fatalf("defaults = surge %d/unavailable %d, want 1/1", bounds.MaxSurge, bounds.MaxUnavailable)
	}
	if bounds.MinAvailable != 3 || bounds.MaxTotal != 5 {
		t.Fatalf("bounds = min %d/max %d, want 3/5", bounds.MinAvailable, bounds.MaxTotal)
	}

	bounds, err = ResolvePolicy(Policy{
		DesiredReplicas: 4,
		MaxSurge:        Int(0),
		MaxUnavailable:  Int(1),
	})
	if err != nil {
		t.Fatalf("ResolvePolicy() error = %v", err)
	}
	if bounds.MaxSurge != 0 {
		t.Fatalf("explicit zero surge was defaulted to %d", bounds.MaxSurge)
	}
}

func TestParseIntOrString(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  IntOrString
		ok    bool
	}{
		{input: "3", want: Int(3), ok: true},
		{input: " 3 ", want: Int(3), ok: true},
		{input: "25%", want: Percent(25), ok: true},
		{input: " 25 % ", want: Percent(25), ok: true},
		{input: "0", want: Int(0), ok: true},
		{input: "0%", want: Percent(0), ok: true},
		{input: "", ok: false},
		{input: "abc", ok: false},
		{input: "-1", ok: false},
		{input: "1.5%", ok: false},
		{input: "25%%", ok: false},
	}
	for _, tt := range tests {
		got, err := ParseIntOrString(tt.input)
		if tt.ok {
			if err != nil {
				t.Errorf("ParseIntOrString(%q) error = %v", tt.input, err)
				continue
			}
			if got != tt.want {
				t.Errorf("ParseIntOrString(%q) = %+v, want %+v", tt.input, got, tt.want)
			}
			continue
		}
		if err == nil {
			t.Errorf("ParseIntOrString(%q) unexpectedly succeeded with %+v", tt.input, got)
		}
	}
}

func TestIntOrStringJSON(t *testing.T) {
	t.Parallel()

	tests := []struct {
		value IntOrString
		json  string
	}{
		{value: Int(3), json: `3`},
		{value: Percent(25), json: `"25%"`},
	}
	for _, tt := range tests {
		data, err := json.Marshal(tt.value)
		if err != nil {
			t.Fatalf("Marshal(%v) error = %v", tt.value, err)
		}
		if string(data) != tt.json {
			t.Errorf("Marshal(%v) = %s, want %s", tt.value, data, tt.json)
		}

		var decoded IntOrString
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("Unmarshal(%s) error = %v", data, err)
		}
		if decoded != tt.value {
			t.Errorf("round trip = %+v, want %+v", decoded, tt.value)
		}
	}

	for _, input := range []string{`"25"`, `25`, `"25%"`} {
		var decoded IntOrString
		if err := json.Unmarshal([]byte(input), &decoded); err != nil {
			t.Errorf("Unmarshal(%s) error = %v", input, err)
		}
	}
	for _, input := range []string{`2.5`, `"2.5%"`, `-1`, `"x%"`} {
		var decoded IntOrString
		if err := json.Unmarshal([]byte(input), &decoded); err == nil {
			t.Errorf("Unmarshal(%s) unexpectedly succeeded with %+v", input, decoded)
		}
	}
}

func TestPolicyValidation(t *testing.T) {
	t.Parallel()

	tests := []Policy{
		{DesiredReplicas: -1, MaxSurge: Int(1)},
		{DesiredReplicas: 1, MaxSurge: Int(-1), MaxUnavailable: Int(1)},
		{DesiredReplicas: 1, MaxSurge: Int(1), MaxUnavailable: Percent(-1)},
		{DesiredReplicas: 1, MaxSurge: Int(1), ReadinessDelay: -time.Second},
		{DesiredReplicas: 1, MaxSurge: Int(1), TerminationGrace: -time.Second},
		{DesiredReplicas: 1, MaxSurge: IntOrString{Type: Type(9), Value: 1}},
	}
	for _, policy := range tests {
		if _, err := ResolvePolicy(policy); err == nil {
			t.Errorf("ResolvePolicy(%+v) unexpectedly succeeded", policy)
		}
	}
}

func TestObservationValidation(t *testing.T) {
	t.Parallel()

	valid := Observation{Now: 0, Total: 5, Available: 3, Terminating: 1, Capacity: 6}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid observation rejected: %v", err)
	}

	invalid := []Observation{
		{Now: -1, Total: 1, Available: 1},
		{Total: -1},
		{Total: 1, Available: 2},
		{Total: 1, Terminating: 2},
		{Total: 2, Available: 2, Terminating: 1},
		{Total: 1, Capacity: -1},
	}
	for _, observation := range invalid {
		if err := observation.Validate(); err == nil {
			t.Errorf("Validate(%+v) unexpectedly succeeded", observation)
		}
	}
}
