package formal

import (
	"errors"
	"sync"
	"time"
)

type routeShard struct {
	mu           sync.Mutex
	route        breakerState
	instances    map[string]*breakerState
	sharedProbes int
}

// Group combines route-level and upstream-instance-level breakers. All
// half-open probes for one route share a single concurrency budget.
type Group struct {
	config Config
	clock  Clock

	mu     sync.RWMutex
	routes map[string]*routeShard
}

// Option customizes a Group.
type Option func(*groupOptions)

type groupOptions struct {
	clock Clock
}

// WithClock injects a clock into a Group.
func WithClock(clock Clock) Option {
	return func(options *groupOptions) {
		options.clock = clock
	}
}

// New creates a route/instance breaker group.
func New(config Config, options ...Option) (*Group, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	settings := groupOptions{clock: RealClock{}}
	for _, option := range options {
		option(&settings)
	}
	if settings.clock == nil {
		return nil, errors.New("formal: clock must not be nil")
	}
	return &Group{
		config: config,
		clock:  settings.clock,
		routes: make(map[string]*routeShard),
	}, nil
}

// NewGroup is an alias for New.
func NewGroup(config Config, options ...Option) (*Group, error) {
	return New(config, options...)
}

func (g *Group) shard(route string) *routeShard {
	g.mu.RLock()
	shard := g.routes[route]
	g.mu.RUnlock()
	if shard != nil {
		return shard
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if shard = g.routes[route]; shard != nil {
		return shard
	}
	shard = &routeShard{
		route:     newBreakerState(g.config.Route),
		instances: make(map[string]*breakerState),
	}
	g.routes[route] = shard
	return shard
}

// Acquire admits a call to one route/instance pair.
//
// Route admission is checked first, followed by the selected instance. If the
// instance rejects the call, it is not recorded by either layer: in particular,
// an ejected instance cannot inflate route failure statistics.
func (g *Group) Acquire(route, instance string) (*Permit, error) {
	shard := g.shard(route)
	now := g.clock.Now()

	shard.mu.Lock()
	defer shard.mu.Unlock()

	shard.route.advance(now)
	state, exists := shard.instances[instance]
	if !exists {
		state = new(breakerState)
		*state = newBreakerState(g.config.Instance)
		shard.instances[instance] = state
	}
	state.advance(now)

	if shard.route.state == StateOpen {
		return nil, ErrRouteOpen
	}
	if state.state == StateOpen {
		return nil, ErrInstanceOpen
	}

	routeProbe := shard.route.state == StateHalfOpen
	instanceProbe := state.state == StateHalfOpen
	if routeProbe || instanceProbe {
		if routeProbe && !shard.route.probeCapacityAvailable() {
			return nil, ErrRouteOpen
		}
		if instanceProbe && !state.probeCapacityAvailable() {
			return nil, ErrInstanceOpen
		}
		if shard.sharedProbes >= g.config.SharedHalfOpenProbes {
			if routeProbe {
				return nil, ErrRouteOpen
			}
			return nil, ErrInstanceOpen
		}
		shard.sharedProbes++
		if routeProbe {
			shard.route.startProbe()
		}
		if instanceProbe {
			state.startProbe()
		}
	}

	return &Permit{
		clock:              g.clock,
		owner:              shard,
		instance:           state,
		started:            now,
		generation:         shard.route.generation,
		instanceGeneration: state.generation,
		sharedProbe:        routeProbe || instanceProbe,
	}, nil
}

// State returns both layers for a route/instance pair.
func (g *Group) State(route, instance string) (routeState, instanceState State) {
	shard := g.lookup(route)
	if shard == nil {
		return StateClosed, StateClosed
	}
	now := g.clock.Now()
	shard.mu.Lock()
	defer shard.mu.Unlock()
	shard.route.advance(now)
	state := shard.instances[instance]
	if state == nil {
		return shard.route.state, StateClosed
	}
	state.advance(now)
	return shard.route.state, state.state
}

// RouteState returns only the route layer state.
func (g *Group) RouteState(route string) State {
	shard := g.lookup(route)
	if shard == nil {
		return StateClosed
	}
	now := g.clock.Now()
	shard.mu.Lock()
	defer shard.mu.Unlock()
	shard.route.advance(now)
	return shard.route.state
}

// InstanceState returns only the upstream instance state.
func (g *Group) InstanceState(route, instance string) State {
	_, instanceState := g.State(route, instance)
	return instanceState
}

// RouteSnapshot returns the route sliding window.
func (g *Group) RouteSnapshot(route string) Snapshot {
	shard := g.lookup(route)
	if shard == nil {
		return Snapshot{State: StateClosed}
	}
	now := g.clock.Now()
	shard.mu.Lock()
	defer shard.mu.Unlock()
	return shard.route.snapshot(now)
}

// InstanceSnapshot returns one instance's sliding window.
func (g *Group) InstanceSnapshot(route, instance string) Snapshot {
	shard := g.lookup(route)
	if shard == nil {
		return Snapshot{State: StateClosed}
	}
	now := g.clock.Now()
	shard.mu.Lock()
	defer shard.mu.Unlock()
	state := shard.instances[instance]
	if state == nil {
		return Snapshot{State: StateClosed}
	}
	return state.snapshot(now)
}

func (g *Group) lookup(route string) *routeShard {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.routes[route]
}

// ForgetInstance drops all state for an instance. The next request creates a
// fresh closed instance breaker. Outstanding permits remain safe to finish.
func (g *Group) ForgetInstance(route, instance string) {
	shard := g.lookup(route)
	if shard == nil {
		return
	}
	shard.mu.Lock()
	delete(shard.instances, instance)
	shard.mu.Unlock()
}

// ForgetRoute drops all state for a route.
func (g *Group) ForgetRoute(route string) {
	g.mu.Lock()
	delete(g.routes, route)
	g.mu.Unlock()
}

func (s *routeShard) finishPermit(permit *Permit, now time.Time, result Result) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if permit.sharedProbe && s.sharedProbes > 0 {
		s.sharedProbes--
	}
	s.route.finish(now, permit.generation, result)
	if permit.instance != nil {
		permit.instance.finish(now, permit.instanceGeneration, result)
	}
}

func (s *routeShard) cancelPermit(permit *Permit) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if permit.sharedProbe && s.sharedProbes > 0 {
		s.sharedProbes--
	}
	s.route.cancelProbe(permit.generation)
	if permit.instance != nil {
		permit.instance.cancelProbe(permit.instanceGeneration)
	}
}
