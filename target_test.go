package formal_test

import (
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func TestTargetScheduleNaturalDay(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skipf("time zone unavailable: %v", err)
	}
	schedule := formal.TargetSchedule{
		Location: shanghai,
		Default:  0.999,
		Daily: map[string]float64{
			"2026-11-17": 0.99,
			"2026-11-18": 0.995,
		},
	}
	if err := schedule.Validate(); err != nil {
		t.Fatal(err)
	}

	before := time.Date(2026, 11, 17, 23, 59, 0, 0, shanghai)
	after := time.Date(2026, 11, 18, 0, 0, 0, 0, shanghai)
	requireFloat(t, "before midnight", schedule.TargetAt(before), 0.99)
	requireFloat(t, "after midnight", schedule.TargetAt(after), 0.995)
	requireFloat(t, "default", schedule.TargetAt(after.AddDate(0, 0, 1)), 0.999)
	if got := schedule.Day(after); got != "2026-11-18" {
		t.Fatalf("Day() = %q", got)
	}
}

func TestTargetScheduleValidation(t *testing.T) {
	cases := []formal.TargetSchedule{
		{},
		{Default: 1},
		{Default: 0.999, Daily: map[string]float64{"2026-1-2": 0.99}},
		{Default: 0.999, Daily: map[string]float64{"2026-01-02": 0}},
	}
	for i, schedule := range cases {
		if err := schedule.Validate(); err == nil {
			t.Fatalf("case %d unexpectedly valid", i)
		}
	}
}
