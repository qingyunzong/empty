package main

import (
	"fmt"
	"sort"
)

// Interval is a live range [Start, End) over integer program points.
type Interval struct {
	Name      string `json:"name"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	LoadCost  int    `json:"loadCost"`
	StoreCost int    `json:"storeCost"`
}

// Call reserves a set of registers at a single program point; reserved
// registers cannot hold any interval at that point.
type Call struct {
	Point    int      `json:"point"`
	Reserved []string `json:"reserved"`
}

// Input is the problem instance.
type Input struct {
	Registers []string   `json:"registers"`
	Intervals []Interval `json:"intervals"`
	Calls     []Call     `json:"calls"`
}

const (
	maxRegisters = 4
	maxIntervals = 16
)

// validate checks structural constraints of the instance.
func validate(in *Input) error {
	if len(in.Registers) == 0 || len(in.Registers) > maxRegisters {
		return fmt.Errorf("need 1..%d registers, got %d", maxRegisters, len(in.Registers))
	}
	if len(in.Intervals) == 0 || len(in.Intervals) > maxIntervals {
		return fmt.Errorf("need 1..%d intervals, got %d", maxIntervals, len(in.Intervals))
	}
	regSet := map[string]bool{}
	for _, r := range in.Registers {
		if regSet[r] {
			return fmt.Errorf("duplicate register %q", r)
		}
		regSet[r] = true
	}
	names := map[string]bool{}
	maxEnd := 0
	for _, iv := range in.Intervals {
		if iv.Name == "" {
			return fmt.Errorf("interval with empty name")
		}
		if names[iv.Name] {
			return fmt.Errorf("duplicate interval name %q", iv.Name)
		}
		names[iv.Name] = true
		if iv.Start < 0 || iv.Start >= iv.End {
			return fmt.Errorf("interval %q: need 0 <= start < end, got [%d,%d)", iv.Name, iv.Start, iv.End)
		}
		if iv.LoadCost < 0 || iv.StoreCost < 0 {
			return fmt.Errorf("interval %q: negative cost", iv.Name)
		}
		if iv.End > maxEnd {
			maxEnd = iv.End
		}
	}
	for _, c := range in.Calls {
		if c.Point < 0 || c.Point >= maxEnd {
			return fmt.Errorf("call at point %d outside program [0,%d)", c.Point, maxEnd)
		}
		seen := map[string]bool{}
		for _, r := range c.Reserved {
			if !regSet[r] {
				return fmt.Errorf("call at point %d reserves unknown register %q", c.Point, r)
			}
			if seen[r] {
				return fmt.Errorf("call at point %d reserves %q twice", c.Point, r)
			}
			seen[r] = true
		}
	}
	return nil
}

// instance is the validated, index-based working form of Input.
type instance struct {
	in        *Input
	numPoints int
	numRegs   int
	// live[p] lists interval indices live at point p (sorted by index).
	live [][]int
	// avail[p] lists register indices usable at point p.
	avail [][]int
	// reservedNames[p] lists reserved register names at p (for reporting).
	reservedNames [][]string
}

func buildInstance(in *Input) *instance {
	inst := &instance{in: in, numRegs: len(in.Registers)}
	for _, iv := range in.Intervals {
		if iv.End > inst.numPoints {
			inst.numPoints = iv.End
		}
	}
	inst.live = make([][]int, inst.numPoints)
	for i, iv := range in.Intervals {
		for p := iv.Start; p < iv.End; p++ {
			inst.live[p] = append(inst.live[p], i)
		}
	}
	regIndex := map[string]int{}
	for i, r := range in.Registers {
		regIndex[r] = i
	}
	reserved := make([]map[int]bool, inst.numPoints)
	for p := range reserved {
		reserved[p] = map[int]bool{}
	}
	inst.reservedNames = make([][]string, inst.numPoints)
	for _, c := range in.Calls {
		for _, r := range c.Reserved {
			reserved[c.Point][regIndex[r]] = true
		}
	}
	inst.avail = make([][]int, inst.numPoints)
	for p := 0; p < inst.numPoints; p++ {
		for ri := 0; ri < inst.numRegs; ri++ {
			if !reserved[p][ri] {
				inst.avail[p] = append(inst.avail[p], ri)
			}
		}
		for ri := range reserved[p] {
			inst.reservedNames[p] = append(inst.reservedNames[p], in.Registers[ri])
		}
		sort.Strings(inst.reservedNames[p])
	}
	return inst
}
