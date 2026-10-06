package main

import (
	"fmt"
	"strings"
)

// Certificate is a complete, independently checkable cycle plan.
type Certificate struct {
	Cycle int
	Alloc []int    // green slots per phase
	Slots []uint64 // per-slot green phase bitmask
	Costs []int    // per-phase waiting cost
	Total int      // total waiting cost
}

// BuildCertificate assembles and verifies a certificate.
func BuildCertificate(inst *Instance, alloc []int, slots []uint64) (*Certificate, error) {
	cert := &Certificate{Cycle: inst.Cycle, Alloc: alloc, Slots: slots}
	cert.Costs = make([]int, len(inst.Phases))
	for i := range inst.Phases {
		cert.Costs[i] = inst.CostOf(i, alloc[i])
		cert.Total += cert.Costs[i]
	}
	if err := cert.Verify(inst); err != nil {
		return nil, err
	}
	return cert, nil
}

// Verify re-checks every constraint of the certificate from scratch.
func (cert *Certificate) Verify(inst *Instance) error {
	n := len(inst.Phases)
	if len(cert.Alloc) != n || len(cert.Slots) != inst.Cycle {
		return fmt.Errorf("certificate shape mismatch")
	}
	count := make([]int, n)
	for s, m := range cert.Slots {
		if m >= 1<<n {
			return fmt.Errorf("slot %d: unknown phase bit set", s)
		}
		for _, pr := range inst.Conflicts {
			if m&(1<<pr[0]) != 0 && m&(1<<pr[1]) != 0 {
				return fmt.Errorf("slot %d: conflicting phases %q and %q both green",
					s, inst.Phases[pr[0]].Name, inst.Phases[pr[1]].Name)
			}
		}
		for i := 0; i < n; i++ {
			if m&(1<<i) != 0 {
				count[i]++
			}
		}
	}
	for i := range inst.Phases {
		if count[i] != cert.Alloc[i] {
			return fmt.Errorf("phase %q: schedule gives %d green slots, allocation says %d",
				inst.Phases[i].Name, count[i], cert.Alloc[i])
		}
		if cert.Alloc[i] < inst.Phases[i].Min {
			return fmt.Errorf("phase %q: green %d below minimum %d",
				inst.Phases[i].Name, cert.Alloc[i], inst.Phases[i].Min)
		}
		if cert.Costs[i] != inst.CostOf(i, cert.Alloc[i]) {
			return fmt.Errorf("phase %q: cost mismatch", inst.Phases[i].Name)
		}
	}
	total := 0
	for _, c := range cert.Costs {
		total += c
	}
	if total != cert.Total {
		return fmt.Errorf("total cost mismatch")
	}
	return nil
}

// String renders the certificate as a human-readable cycle plan.
func (cert *Certificate) String(inst *Instance) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CYCLE %d\n", cert.Cycle)
	b.WriteString("ALLOC")
	for i, p := range inst.Phases {
		fmt.Fprintf(&b, " %s=%d", p.Name, cert.Alloc[i])
	}
	b.WriteString("\nSLOTS\n")
	for s, m := range cert.Slots {
		names := []string{}
		for i, p := range inst.Phases {
			if m&(1<<i) != 0 {
				names = append(names, p.Name)
			}
		}
		if len(names) == 0 {
			names = []string{"-"}
		}
		fmt.Fprintf(&b, " %2d: %s\n", s, strings.Join(names, " "))
	}
	b.WriteString("COST")
	for i, p := range inst.Phases {
		fmt.Fprintf(&b, " %s=%d", p.Name, cert.Costs[i])
	}
	fmt.Fprintf(&b, " TOTAL=%d\n", cert.Total)
	b.WriteString("CHECK ok: min-times ok, conflicts ok, costs ok\n")
	return b.String()
}
