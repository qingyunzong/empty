package formal

import (
	"fmt"
	"time"
)

// ActionKind is the kind of scaling operation to apply for a step.
type ActionKind string

const (
	// ActionNone means the workload is at a stable point or must wait.
	ActionNone ActionKind = "none"
	// ActionScaleUp creates replicas. They become available after ReadyAt.
	ActionScaleUp ActionKind = "scale-up"
	// ActionScaleDown starts terminations. They leave Total at CompleteBy.
	ActionScaleDown ActionKind = "scale-down"
)

// Action is one planning step.
type Action struct {
	Kind     ActionKind
	Replicas int

	// TerminateUnready and TerminateReady split a scale-down so that the
	// release manager can prefer pods that do not currently contribute to
	// availability. Their sum is Replicas.
	TerminateUnready int
	TerminateReady   int

	// ReadyAt is set for scale-up: the new replicas are expected to become
	// available at this time if readiness succeeds.
	ReadyAt time.Duration
	// CompleteBy is set for scale-down: the started terminations finish at
	// this time. They must not be withdrawn before then.
	CompleteBy time.Duration

	Reason string
}

// TerminationBatch records terminations started by the planner.
type TerminationBatch struct {
	ID        uint64
	Replicas  int
	StartedAt time.Duration
	Deadline  time.Duration
	Reason    string
}

// Decision is the planner result for one observation.
type Decision struct {
	At          time.Duration
	Action      Action
	Bounds      Bounds
	Observation Observation

	// TargetTotal is the stable total for the observed capacity:
	// min(desiredReplicas, capacity).
	TargetTotal int
	// MaxTotal is the total this step may reach:
	// min(Bounds.MaxTotal, capacity).
	MaxTotal int

	// ProjectedTotal is the total immediately after the action is applied.
	// A scale-down leaves Total unchanged until its CompleteBy deadline, while
	// a scale-up raises it immediately.
	ProjectedTotal int
	// ProjectedAvailable treats pods whose termination just started as
	// unavailable immediately. This is the conservative value used to enforce
	// the availability floor.
	ProjectedAvailable int

	// Converged is true when no work remains and the workload has reached the
	// stable total for the current capacity.
	Converged bool
	// Feasible reports whether the availability floor is reachable at the
	// current capacity.
	Feasible bool
	// Observed and projected availability remain inside
	// [MinAvailable, MaxTotal] when these fields are true.
	ObservedAvailableInBounds  bool
	ProjectedAvailableInBounds bool

	// PendingTerminations contains every termination batch that has started
	// but whose grace period has not elapsed. Batches are never removed early
	// by a recomputation.
	PendingTerminations []TerminationBatch
}

// Planner produces one scaling action at a time from observed aggregate state.
//
// The caller must apply the returned action before calling Step again. The
// planner intentionally has no cancel operation: a termination that has been
// started is only forgotten when its deadline passes.
type Planner struct {
	policy  Policy
	bounds  Bounds
	pending []TerminationBatch
	nextID  uint64
	now     time.Duration
	haveNow bool
}

// NewPlanner validates a policy and creates a planner.
func NewPlanner(policy Policy) (*Planner, error) {
	policy = policy.WithKubernetesDefaults()
	bounds, err := ResolvePolicy(policy)
	if err != nil {
		return nil, err
	}
	return &Planner{
		policy: policy,
		bounds: bounds,
		nextID: 1,
	}, nil
}

// Policy returns the effective policy, including Kubernetes defaults.
func (p *Planner) Policy() Policy {
	return p.policy
}

// Bounds returns the resolved replica limits of the current policy.
func (p *Planner) Bounds() Bounds {
	return p.bounds
}

// UpdatePolicy recomputes limits while preserving every termination batch that
// has already started. A changed termination grace applies only to terminations
// started after the update; existing deadlines do not move.
func (p *Planner) UpdatePolicy(policy Policy) error {
	policy = policy.WithKubernetesDefaults()
	bounds, err := ResolvePolicy(policy)
	if err != nil {
		return err
	}
	p.policy = policy
	p.bounds = bounds
	return nil
}

// PendingTerminations returns a copy of the planner's termination ledger.
func (p *Planner) PendingTerminations() []TerminationBatch {
	out := make([]TerminationBatch, len(p.pending))
	copy(out, p.pending)
	return out
}

// Step consumes the state observed after the previous action and returns the
// next action. Time must not move backwards. Calling Step again with an
// observation that does not reflect the previous action can produce a duplicate
// action; the release manager should apply each Decision before observing again.
func (p *Planner) Step(observation Observation) (Decision, error) {
	if err := observation.Validate(); err != nil {
		return Decision{}, err
	}
	if p.haveNow && observation.Now < p.now {
		return Decision{}, fmt.Errorf("observation time moved backwards from %s to %s", p.now, observation.Now)
	}
	p.now = observation.Now
	p.haveNow = true
	p.expireTerminations(observation.Now)

	decision := p.decide(observation)
	if decision.Action.Kind == ActionScaleDown && decision.Action.Replicas > 0 {
		p.pending = append(p.pending, TerminationBatch{
			ID:        p.nextID,
			Replicas:  decision.Action.Replicas,
			StartedAt: observation.Now,
			Deadline:  observation.Now + p.policy.TerminationGrace,
			Reason:    decision.Action.Reason,
		})
		p.nextID++
	}
	decision.PendingTerminations = p.PendingTerminations()
	return decision, nil
}

func (p *Planner) expireTerminations(now time.Duration) {
	kept := p.pending[:0]
	for _, batch := range p.pending {
		if batch.Deadline > now {
			kept = append(kept, batch)
		}
	}
	p.pending = kept
}

func (p *Planner) decide(observation Observation) Decision {
	bounds := p.bounds
	target := bounds.Target(observation.Capacity)
	maxTotal := bounds.MaxTotal
	if observation.Capacity < maxTotal {
		maxTotal = observation.Capacity
	}
	if maxTotal < 0 {
		maxTotal = 0
	}

	decision := Decision{
		At:          observation.Now,
		Bounds:      bounds,
		Observation: observation,
		TargetTotal: target,
		MaxTotal:    maxTotal,
		Feasible:    bounds.MinAvailable <= target,
	}

	unready := observation.Unready()
	kept := observation.NonTerminating()

	// First remove committed replicas above the stable target. Unready pods
	// are free to terminate; ready pods may only consume the allowance above
	// the availability floor.
	remove := kept - target
	if remove < 0 {
		remove = 0
	}
	if remove > 0 {
		readyRoom := observation.Available - bounds.MinAvailable
		if readyRoom < 0 {
			readyRoom = 0
		}
		removable := unready + readyRoom
		count := remove
		if count > removable {
			count = removable
		}
		if count > 0 {
			unreadyCount := count
			if unreadyCount > unready {
				unreadyCount = unready
			}
			readyCount := count - unreadyCount
			reason := "scale down to desired replicas"
			if target < bounds.Desired {
				reason = "scale down to node capacity"
			}
			decision.Action = Action{
				Kind:             ActionScaleDown,
				Replicas:         count,
				TerminateUnready: unreadyCount,
				TerminateReady:   readyCount,
				CompleteBy:       observation.Now + p.policy.TerminationGrace,
				Reason:           reason,
			}
			decision.ProjectedTotal = observation.Total
			decision.ProjectedAvailable = observation.Available - readyCount
			p.finishDecision(&decision)
			return decision
		}
	}

	// Add replicas when the committed total is below target, or when the
	// availability floor is short and there is surge capacity left. The raw
	// total includes terminating pods, so terminations release capacity only
	// when their grace period actually completes.
	need := 0
	if kept < target {
		need = target - kept
	}
	if kept <= target && observation.Available < bounds.MinAvailable {
		deficit := bounds.MinAvailable - observation.Available
		if deficit > need {
			need = deficit
		}
	}
	budget := maxTotal - observation.Total
	if budget < 0 {
		budget = 0
	}
	add := need
	if add > budget {
		add = budget
	}
	if add > 0 {
		reason := "scale up to desired replicas"
		if observation.Available < bounds.MinAvailable {
			reason = "scale up to restore minimum availability"
		}
		decision.Action = Action{
			Kind:     ActionScaleUp,
			Replicas: add,
			ReadyAt:  observation.Now + p.policy.ReadinessDelay,
			Reason:   reason,
		}
		decision.ProjectedTotal = observation.Total + add
		decision.ProjectedAvailable = observation.Available
		p.finishDecision(&decision)
		return decision
	}

	decision.Action = Action{Kind: ActionNone}
	decision.ProjectedTotal = observation.Total
	decision.ProjectedAvailable = observation.Available
	switch {
	case observation.Terminating > 0:
		decision.Action.Reason = "waiting for terminations to complete"
	case remove > 0:
		decision.Action.Reason = "waiting for a safe termination budget"
	case need > 0:
		decision.Action.Reason = "waiting for node capacity or readiness"
	case observation.Total == target && observation.Available == target:
		decision.Action.Reason = "converged"
	default:
		decision.Action.Reason = "waiting for readiness"
	}
	p.finishDecision(&decision)
	return decision
}

func (p *Planner) finishDecision(decision *Decision) {
	observation := decision.Observation
	decision.ObservedAvailableInBounds = p.bounds.AvailableInBounds(observation.Available)
	decision.ProjectedAvailableInBounds = p.bounds.AvailableInBounds(decision.ProjectedAvailable)
	decision.Converged = decision.Action.Kind == ActionNone &&
		observation.Terminating == 0 &&
		observation.Total == decision.TargetTotal &&
		observation.Available == decision.TargetTotal
}
