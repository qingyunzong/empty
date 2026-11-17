package formal

import (
	"fmt"
	"math"
	"time"
)

const defaultPercentage = 25

// Policy describes the desired state and disruption limits of a release.
type Policy struct {
	DesiredReplicas  int
	MaxSurge         IntOrString
	MaxUnavailable   IntOrString
	ReadinessDelay   time.Duration
	TerminationGrace time.Duration
}

// Bounds is a Policy resolved against its desired replica count.
type Bounds struct {
	Desired        int
	MaxSurge       int
	MaxUnavailable int
	MaxTotal       int
	MinAvailable   int
}

// WithKubernetesDefaults applies the API-server defaulting rule used when both
// rolling-update limits are omitted (both are zero): both become 25%.
//
// Because IntOrString cannot distinguish an omitted zero from an explicitly
// configured zero, a caller that intentionally needs the 0/0 combination
// should use absolute limits in a policy where at least one limit is nonzero.
func (p Policy) WithKubernetesDefaults() Policy {
	if p.MaxSurge.isZero() && p.MaxUnavailable.isZero() {
		p.MaxSurge = Percent(defaultPercentage)
		p.MaxUnavailable = Percent(defaultPercentage)
	}
	return p
}

// ResolvePolicy validates a policy, applies Kubernetes defaulting, and resolves
// percentages against DesiredReplicas.
//
// maxSurge is rounded up and maxUnavailable is rounded down.
func ResolvePolicy(p Policy) (Bounds, error) {
	if p.DesiredReplicas < 0 {
		return Bounds{}, fmt.Errorf("desired replicas must not be negative: %d", p.DesiredReplicas)
	}
	if p.DesiredReplicas > math.MaxInt32 {
		return Bounds{}, fmt.Errorf("desired replicas is too large: %d", p.DesiredReplicas)
	}
	if p.ReadinessDelay < 0 {
		return Bounds{}, fmt.Errorf("readiness delay must not be negative: %s", p.ReadinessDelay)
	}
	if p.TerminationGrace < 0 {
		return Bounds{}, fmt.Errorf("termination grace must not be negative: %s", p.TerminationGrace)
	}

	p = p.WithKubernetesDefaults()
	if err := p.MaxSurge.Validate(); err != nil {
		return Bounds{}, fmt.Errorf("maxSurge: %w", err)
	}
	if err := p.MaxUnavailable.Validate(); err != nil {
		return Bounds{}, fmt.Errorf("maxUnavailable: %w", err)
	}

	maxSurge, err := p.MaxSurge.resolve(p.DesiredReplicas, true)
	if err != nil {
		return Bounds{}, fmt.Errorf("maxSurge: %w", err)
	}
	maxUnavailable, err := p.MaxUnavailable.resolve(p.DesiredReplicas, false)
	if err != nil {
		return Bounds{}, fmt.Errorf("maxUnavailable: %w", err)
	}
	if maxSurge > math.MaxInt-p.DesiredReplicas {
		return Bounds{}, fmt.Errorf("maxSurge overflows the replica count")
	}

	minAvailable := p.DesiredReplicas - maxUnavailable
	if minAvailable < 0 {
		minAvailable = 0
	}
	return Bounds{
		Desired:        p.DesiredReplicas,
		MaxSurge:       maxSurge,
		MaxUnavailable: maxUnavailable,
		MaxTotal:       p.DesiredReplicas + maxSurge,
		MinAvailable:   minAvailable,
	}, nil
}

// Target returns the stable total replica count for a node capacity. A
// capacity smaller than the desired count limits the converged total.
func (b Bounds) Target(capacity int) int {
	if capacity < 0 {
		return 0
	}
	if capacity < b.Desired {
		return capacity
	}
	return b.Desired
}

// AvailableInBounds reports whether an availability observation satisfies the
// disruption policy. Capacity can make the lower bound physically impossible;
// callers that need to distinguish that case should also inspect the planner's
// Feasible result.
func (b Bounds) AvailableInBounds(available int) bool {
	return available >= b.MinAvailable && available <= b.MaxTotal
}
