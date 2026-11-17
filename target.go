package formal

import (
	"fmt"
	"math"
	"time"
)

const targetDayLayout = "2006-01-02"

// TargetSchedule maps each natural calendar day in Location to an objective.
//
// Natural days are looked up using the start instant of each bucket. A bucket
// that starts before midnight therefore uses the previous day's target even if
// it extends past midnight; use a bucket width that divides a day to avoid that
// ambiguity. A nil Location means UTC.
type TargetSchedule struct {
	Location *time.Location
	Default  float64
	// Daily overrides Default for specific days formatted as "2006-01-02".
	Daily map[string]float64
}

// FixedTarget returns a schedule with the same objective every day.
func FixedTarget(target float64) TargetSchedule {
	return TargetSchedule{Default: target}
}

// TargetAt returns the objective for the natural day containing t.
func (s TargetSchedule) TargetAt(t time.Time) float64 {
	if target, ok := s.Daily[s.Day(t)]; ok {
		return target
	}
	return s.Default
}

// Day formats the natural day containing t in the schedule's location.
func (s TargetSchedule) Day(t time.Time) string {
	return t.In(s.location()).Format(targetDayLayout)
}

// Validate reports whether the schedule contains only usable objectives.
func (s TargetSchedule) Validate() error {
	if !validTarget(s.Default) {
		return fmt.Errorf("formal: default SLO target %v must be in (0, 1)", s.Default)
	}
	loc := s.location()
	for day, target := range s.Daily {
		parsed, err := time.ParseInLocation(targetDayLayout, day, loc)
		if err != nil || parsed.Format(targetDayLayout) != day {
			return fmt.Errorf("formal: target day %q must use format %s", day, targetDayLayout)
		}
		if !validTarget(target) {
			return fmt.Errorf("formal: SLO target %v for %s must be in (0, 1)", target, day)
		}
	}
	return nil
}

func validTarget(target float64) bool {
	return !math.IsNaN(target) && !math.IsInf(target, 0) && target > 0 && target < 1
}

func (s TargetSchedule) location() *time.Location {
	if s.Location == nil {
		return time.UTC
	}
	return s.Location
}

func (s TargetSchedule) clone() TargetSchedule {
	out := s
	if s.Daily != nil {
		out.Daily = make(map[string]float64, len(s.Daily))
		for day, target := range s.Daily {
			out.Daily[day] = target
		}
	}
	return out
}
