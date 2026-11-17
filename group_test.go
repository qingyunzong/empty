package formal

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func groupPolicy(min uint64, timeout time.Duration, probes, successes int) Policy {
	return Policy{
		Window:                10 * time.Second,
		Buckets:               10,
		MinRequests:           min,
		FailureRate:           1,
		SlowRate:              1,
		SlowThreshold:         100 * time.Millisecond,
		OpenTimeout:           timeout,
		HalfOpenMaxConcurrent: probes,
		HalfOpenSuccesses:     successes,
	}
}

func mustGroup(t *testing.T, config Config, clock *VirtualClock) *Group {
	t.Helper()
	group, err := New(config, WithClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	return group
}

func finishFailure(t *testing.T, group *Group, route, instance string) {
	t.Helper()
	permit, err := group.Acquire(route, instance)
	if err != nil {
		t.Fatalf("Acquire(%q, %q): %v", route, instance, err)
	}
	permit.DoneWithLatency(true, time.Millisecond)
}

func openRouteAndInstances(t *testing.T, group *Group, route string, instances, failuresEach int) {
	t.Helper()
	for index := range instances {
		instance := fmt.Sprintf("instance-%d", index)
		for range failuresEach {
			finishFailure(t, group, route, instance)
		}
	}
}

func TestGroupEjectedInstanceDoesNotPolluteRouteStatistics(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	config := Config{
		Route:                groupPolicy(10, time.Second, 2, 1),
		Instance:             groupPolicy(1, time.Second, 2, 1),
		SharedHalfOpenProbes: 2,
	}
	group := mustGroup(t, config, clock)

	finishFailure(t, group, "catalog", "bad")
	route := group.RouteSnapshot("catalog")
	if route.State != StateClosed || route.Total != 1 || route.Failures != 1 {
		t.Fatalf("route snapshot = %+v, want one failure in a closed breaker", route)
	}
	if got := group.InstanceState("catalog", "bad"); got != StateOpen {
		t.Fatalf("instance state = %s, want open", got)
	}

	for range 20 {
		permit, err := group.Acquire("catalog", "bad")
		if permit != nil {
			t.Fatal("ejected instance admitted a request")
		}
		if !errors.Is(err, ErrInstanceOpen) || !errors.Is(err, ErrOpen) {
			t.Fatalf("error = %v, want ErrInstanceOpen", err)
		}
	}
	if route = group.RouteSnapshot("catalog"); route.Total != 1 || route.Failures != 1 {
		t.Fatalf("instance rejections leaked into route window: %+v", route)
	}
	if got := group.RouteState("catalog"); got != StateClosed {
		t.Fatalf("route state = %s after instance ejections, want closed", got)
	}

	permit, err := group.Acquire("catalog", "good")
	if err != nil {
		t.Fatal(err)
	}
	permit.Success()
	if route = group.RouteSnapshot("catalog"); route.Total != 2 || route.Failures != 1 {
		t.Fatalf("route snapshot after healthy call = %+v, want two calls", route)
	}
}

func TestGroupRecordsBothLayers(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	config := Config{
		Route:                groupPolicy(100, time.Second, 2, 1),
		Instance:             groupPolicy(100, time.Second, 2, 1),
		SharedHalfOpenProbes: 2,
	}
	group := mustGroup(t, config, clock)

	permit, err := group.Acquire("orders", "upstream-a")
	if err != nil {
		t.Fatal(err)
	}
	permit.DoneWithLatency(false, 500*time.Millisecond)

	for name, snapshot := range map[string]Snapshot{
		"route":    group.RouteSnapshot("orders"),
		"instance": group.InstanceSnapshot("orders", "upstream-a"),
	} {
		if snapshot.Total != 1 || snapshot.Failures != 0 || snapshot.SlowCalls != 1 {
			t.Fatalf("%s snapshot = %+v, want one slow success", name, snapshot)
		}
	}
}

func TestGroupSharedHalfOpenQuotaIsConserved(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	config := Config{
		Route:                groupPolicy(6, 10*time.Second, 16, 2),
		Instance:             groupPolicy(2, 10*time.Second, 16, 1),
		SharedHalfOpenProbes: 2,
	}
	group := mustGroup(t, config, clock)
	openRouteAndInstances(t, group, "search", 3, 2)

	if got := group.RouteState("search"); got != StateOpen {
		t.Fatalf("route state = %s, want open", got)
	}
	clock.Advance(config.Route.OpenTimeout)

	const attempts = 24
	start := make(chan struct{})
	permits := make(chan *Permit, attempts)
	errs := make(chan error, attempts)
	var wait sync.WaitGroup
	for index := range attempts {
		instance := fmt.Sprintf("instance-%d", index%3)
		wait.Add(1)
		go func(instance string) {
			defer wait.Done()
			<-start
			permit, err := group.Acquire("search", instance)
			if err != nil {
				errs <- err
				return
			}
			permits <- permit
		}(instance)
	}
	close(start)
	wait.Wait()
	close(permits)
	close(errs)

	var admitted []*Permit
	for permit := range permits {
		admitted = append(admitted, permit)
	}
	if len(admitted) != config.SharedHalfOpenProbes {
		t.Fatalf("admitted %d probes, want %d", len(admitted), config.SharedHalfOpenProbes)
	}
	for err := range errs {
		if !errors.Is(err, ErrOpen) {
			t.Fatalf("probe rejection error = %v, want ErrOpen", err)
		}
	}
	if inFlight := sharedProbeCount(group, "search"); inFlight != 2 {
		t.Fatalf("shared probes = %d, want 2", inFlight)
	}

	admitted[0].Cancel()
	if inFlight := sharedProbeCount(group, "search"); inFlight != 1 {
		t.Fatalf("shared probes after cancel = %d, want 1", inFlight)
	}
	replacement, err := group.Acquire("search", "instance-0")
	if err != nil {
		t.Fatalf("probe capacity was not returned by Cancel: %v", err)
	}
	if inFlight := sharedProbeCount(group, "search"); inFlight != 2 {
		t.Fatalf("shared probes after replacement = %d, want 2", inFlight)
	}

	admitted[1].Success()
	replacement.Success()
	if got := group.RouteState("search"); got != StateClosed {
		t.Fatalf("route state = %s after two successful probes, want closed", got)
	}

	for _, instance := range []string{"instance-0", "instance-1", "instance-2"} {
		if group.InstanceState("search", instance) != StateHalfOpen {
			continue
		}
		permit, err := group.Acquire("search", instance)
		if err != nil {
			t.Fatalf("recover instance %s: %v", instance, err)
		}
		permit.Success()
	}
	if inFlight := sharedProbeCount(group, "search"); inFlight != 0 {
		t.Fatalf("shared probes leaked after recovery: %d", inFlight)
	}
	for _, instance := range []string{"instance-0", "instance-1", "instance-2"} {
		if got := group.InstanceState("search", instance); got != StateClosed {
			t.Fatalf("instance %s state = %s, want closed", instance, got)
		}
	}
}

func TestGroupRecoversInstanceBeforeRoute(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	config := Config{
		Route:                groupPolicy(6, time.Second, 4, 2),
		Instance:             groupPolicy(2, 5*time.Second, 4, 1),
		SharedHalfOpenProbes: 4,
	}
	group := mustGroup(t, config, clock)
	openRouteAndInstances(t, group, "checkout", 3, 2)

	clock.Advance(config.Route.OpenTimeout)
	if got := group.RouteState("checkout"); got != StateHalfOpen {
		t.Fatalf("route state = %s, want half-open", got)
	}
	if got := group.InstanceState("checkout", "instance-0"); got != StateOpen {
		t.Fatalf("instance state = %s before its timeout, want open", got)
	}
	if _, err := group.Acquire("checkout", "instance-0"); !errors.Is(err, ErrInstanceOpen) {
		t.Fatalf("error = %v, want ErrInstanceOpen", err)
	}
	if inFlight := sharedProbeCount(group, "checkout"); inFlight != 0 {
		t.Fatalf("unavailable instance consumed %d shared probes", inFlight)
	}
	if got := group.RouteState("checkout"); got != StateHalfOpen {
		t.Fatalf("route state = %s while all instances are ejected, want half-open", got)
	}

	clock.Advance(4 * time.Second)
	first, err := group.Acquire("checkout", "instance-0")
	if err != nil {
		t.Fatal(err)
	}
	first.Success()
	if got := group.InstanceState("checkout", "instance-0"); got != StateClosed {
		t.Fatalf("instance state = %s, want closed", got)
	}
	if got := group.RouteState("checkout"); got != StateHalfOpen {
		t.Fatalf("route state = %s after one probe, want half-open", got)
	}

	second, err := group.Acquire("checkout", "instance-0")
	if err != nil {
		t.Fatal(err)
	}
	second.Success()
	if got := group.RouteState("checkout"); got != StateClosed {
		t.Fatalf("route state = %s after recovery probes, want closed", got)
	}
}

func sharedProbeCount(group *Group, route string) int {
	shard := group.lookup(route)
	if shard == nil {
		return 0
	}
	shard.mu.Lock()
	defer shard.mu.Unlock()
	return shard.sharedProbes
}
