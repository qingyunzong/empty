package dataeng

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func registerValues(start, count uint16, first uint16) []Register {
	registers := make([]Register, count)
	for i := range registers {
		registers[i] = Register{Address: start + uint16(i), Value: first + uint16(i)}
	}
	return registers
}

func TestSnapshotCombinesRanges(t *testing.T) {
	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		registers := registerValues(request.Start, request.Count, 0)
		for i := range registers {
			registers[i].Value = registers[i].Address * 10
		}
		return registers, nil
	})

	coordinator := NewCoordinator(reader)
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:   time.Second,
		Ranges:  []ReadRange{{Start: 10, Count: 3}, {Start: 20, Count: 2}},
		UnitID:  1,
		Retries: 0,
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Generation != 1 || snapshot.Sequence != 1 {
		t.Fatalf("unexpected generation/sequence: %d/%d", snapshot.Generation, snapshot.Sequence)
	}
	if len(snapshot.Registers) != 5 {
		t.Fatalf("expected 5 registers, got %d", len(snapshot.Registers))
	}
	for addr := uint16(10); addr < 13; addr++ {
		if snapshot.Values[addr] != addr*10 {
			t.Fatalf("address %d: got %d, want %d", addr, snapshot.Values[addr], addr*10)
		}
	}
	if snapshot.Values[20] != 200 || snapshot.Values[21] != 210 {
		t.Fatalf("unexpected second range: %+v", snapshot.Values)
	}
}

func TestOverlappingRangesMustAgree(t *testing.T) {
	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		registers := registerValues(request.Start, request.Count, 0)
		for i := range registers {
			registers[i].Value = 100
		}
		return registers, nil
	})

	coordinator := NewCoordinator(reader)
	_, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 10, Count: 4}, {Start: 12, Count: 4}},
	})
	if err != nil {
		t.Fatalf("overlapping equal values should be accepted: %v", err)
	}
}

func TestOverlapConflictRejectsWholeRound(t *testing.T) {
	values := map[uint16]uint16{0: 1, 1: 2, 2: 3, 3: 4}
	var mu sync.Mutex
	conflict := false

	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		mu.Lock()
		defer mu.Unlock()
		registers := registerValues(request.Start, request.Count, 0)
		for i := range registers {
			registers[i].Value = values[registers[i].Address]
			if conflict && request.Start == 2 && i == 0 {
				registers[i].Value = 99
			}
		}
		return registers, nil
	})

	coordinator := NewCoordinator(reader)
	plan := PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 0, Count: 4}, {Start: 2, Count: 2}},
	}

	first, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("first snapshot: %v", err)
	}

	mu.Lock()
	conflict = true
	mu.Unlock()

	second, err := coordinator.Snapshot(context.Background(), plan)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	if second != nil {
		t.Fatalf("conflicting round returned a snapshot: %+v", second)
	}
	if coordinator.Generation() != 1 {
		t.Fatalf("failed round changed generation to %d", coordinator.Generation())
	}
	if last := coordinator.LastSnapshot(); last == nil || last.Sequence != first.Sequence {
		t.Fatalf("failed round replaced or mixed the last snapshot: %+v", last)
	}
	var conflictError *ConflictError
	if !errors.As(err, &conflictError) || conflictError.Address != 2 {
		t.Fatalf("unexpected conflict detail: %+v", err)
	}

	mu.Lock()
	conflict = false
	values[2] = 3
	mu.Unlock()
	third, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("third snapshot: %v", err)
	}
	if third.Sequence != 2 || third.Values[2] != 3 {
		t.Fatalf("third snapshot mixed stale data: %+v", third)
	}
}

func TestRetryOnlyFailedRangeWithSameBudget(t *testing.T) {
	var mu sync.Mutex
	attempts := make(map[uint16]int)
	var deadlines []time.Time

	reader := ReaderFunc(func(ctx context.Context, request ReadRange) ([]Register, error) {
		mu.Lock()
		attempts[request.Start]++
		attempt := attempts[request.Start]
		deadline, _ := ctx.Deadline()
		deadlines = append(deadlines, deadline)
		mu.Unlock()

		if request.Start == 10 && attempt == 1 {
			return nil, context.DeadlineExceeded
		}
		return registerValues(request.Start, request.Count, request.Start), nil
	})

	coordinator := NewCoordinator(reader, WithMaxRetries(1))
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  250 * time.Millisecond,
		Ranges: []ReadRange{{Start: 0, Count: 2}, {Start: 10, Count: 2}},
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if attempts[0] != 1 {
		t.Fatalf("successful range was retried: %d attempts", attempts[0])
	}
	if attempts[10] != 2 {
		t.Fatalf("failed range attempts: %d", attempts[10])
	}
	for _, deadline := range deadlines {
		if !deadline.Equal(deadlines[0]) {
			t.Fatalf("retry changed the round deadline: %v != %v", deadline, deadlines[0])
		}
	}
	if snapshot.Values[10] != 10 || snapshot.Values[11] != 11 {
		t.Fatalf("unexpected retried values: %+v", snapshot.Values)
	}
}

func TestPerAttemptTimeoutDoesNotExtendRoundBudget(t *testing.T) {
	var mu sync.Mutex
	attempts := 0
	var deadlines []time.Time

	reader := ReaderFunc(func(ctx context.Context, request ReadRange) ([]Register, error) {
		mu.Lock()
		attempts++
		attempt := attempts
		deadline, _ := ctx.Deadline()
		deadlines = append(deadlines, deadline)
		mu.Unlock()

		if attempt == 1 {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return registerValues(request.Start, request.Count, request.Start), nil
	})

	roundStart := time.Now()
	coordinator := NewCoordinator(reader, WithMaxRetries(1), WithAttemptTimeout(10*time.Millisecond))
	_, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  60 * time.Millisecond,
		Ranges: []ReadRange{{Start: 0, Count: 1}},
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if time.Since(roundStart) > 60*time.Millisecond {
		t.Fatalf("retry extended the round budget")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(deadlines) != 2 {
		t.Fatalf("expected two attempts, got %d", len(deadlines))
	}
	roundDeadline := roundStart.Add(60 * time.Millisecond)
	for _, deadline := range deadlines {
		if deadline.After(roundDeadline.Add(time.Millisecond)) {
			t.Fatalf("attempt deadline %v exceeded round deadline %v", deadline, roundDeadline)
		}
	}
}

func TestTimeoutNeverFallsBackToPreviousRound(t *testing.T) {
	values := map[uint16]uint16{0: 1, 1: 2}
	blocked := false

	reader := ReaderFunc(func(ctx context.Context, request ReadRange) ([]Register, error) {
		if blocked && request.Start == 10 {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if request.Start == 10 {
			return registerValues(10, request.Count, 10), nil
		}
		return registerValues(request.Start, request.Count, 0), nil
	})

	coordinator := NewCoordinator(reader, WithMaxRetries(1))
	plan := PollPlan{
		Cycle:  40 * time.Millisecond,
		Ranges: []ReadRange{{Start: 0, Count: 2}, {Start: 10, Count: 2}},
	}
	first, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	values[0] = 1

	blocked = true
	second, err := coordinator.Snapshot(context.Background(), plan)
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("expected timeout, got %v", err)
	}
	if second != nil {
		t.Fatalf("timeout returned a snapshot: %+v", second)
	}
	last := coordinator.LastSnapshot()
	if last == nil || last.Sequence != first.Sequence {
		t.Fatalf("failed round changed the last snapshot: %+v", last)
	}
	for addr, value := range last.Values {
		if addr >= 10 && value != addr {
			t.Fatalf("last snapshot contains a mixed value at %d: %d", addr, value)
		}
	}
}

func TestRestartCounterStartsNewGeneration(t *testing.T) {
	var mu sync.Mutex
	restart := uint16(5)

	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		mu.Lock()
		defer mu.Unlock()
		registers := registerValues(request.Start, request.Count, request.Start+100)
		for i := range registers {
			if registers[i].Address == 0 {
				registers[i].Value = restart
			}
		}
		return registers, nil
	})

	coordinator := NewCoordinator(reader, WithRestartRegister(0))
	plan := PollPlan{Cycle: time.Second, Ranges: []ReadRange{{Start: 0, Count: 3}}}

	first, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	if first.Generation != 1 || !first.HasRestartCount || first.RestartCount != 5 {
		t.Fatalf("unexpected first snapshot: %+v", first)
	}

	second, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("second snapshot: %v", err)
	}
	if second.Generation != 1 || second.Sequence != 2 {
		t.Fatalf("unchanged restart counter changed generation: %+v", second)
	}

	mu.Lock()
	restart = 6
	mu.Unlock()
	third, err := coordinator.Snapshot(context.Background(), plan)
	if err != nil {
		t.Fatalf("third snapshot: %v", err)
	}
	if third.Generation != 2 || third.RestartCount != 6 {
		t.Fatalf("restart counter did not open a new generation: %+v", third)
	}
	if third.Values[1] != 101 || third.Values[2] != 102 {
		t.Fatalf("new generation mixed old values: %+v", third.Values)
	}
}

func TestRestartRegisterIsReadWhenNotInPlan(t *testing.T) {
	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		registers := registerValues(request.Start, request.Count, request.Start)
		if request.Contains(0) {
			registers[0].Value = 1
		}
		return registers, nil
	})

	coordinator := NewCoordinator(reader, WithRestartRegister(0))
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 10, Count: 2}},
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !snapshot.HasRestartCount || snapshot.RestartCount != 1 {
		t.Fatalf("restart register was not added to the round: %+v", snapshot)
	}
	if len(snapshot.Ranges) != 2 {
		t.Fatalf("effective ranges: %+v", snapshot.Ranges)
	}
}

type restartReportingReader struct{}

func (restartReportingReader) ReadRange(_ context.Context, request ReadRange) (RangeReading, error) {
	restart := uint16(5)
	if request.Start >= 10 {
		restart = 6
	}
	return RangeReading{
		Range:           request,
		Registers:       registerValues(request.Start, request.Count, request.Start),
		RestartCount:    restart,
		HasRestartCount: true,
	}, nil
}

func TestReaderRestartCountMustBeStableAcrossRound(t *testing.T) {
	coordinator := NewCoordinator(restartReportingReader{})
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 0, Count: 2}, {Start: 10, Count: 2}},
	})
	if !errors.Is(err, ErrGenerationChanged) {
		t.Fatalf("expected generation change, got %v", err)
	}
	if snapshot != nil {
		t.Fatalf("generation change returned a snapshot: %+v", snapshot)
	}
}

func TestIncompleteRangeRejectsRound(t *testing.T) {
	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		return registerValues(request.Start, request.Count-1, request.Start), nil
	})

	coordinator := NewCoordinator(reader, WithMaxRetries(0))
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 0, Count: 3}},
	})
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("expected incomplete range, got %v", err)
	}
	if snapshot != nil {
		t.Fatalf("incomplete range returned a snapshot: %+v", snapshot)
	}
}

func TestRegisterReaderAdapter(t *testing.T) {
	reader := RegisterReaderFunc(func(_ context.Context, start, count uint16) ([]uint16, error) {
		values := make([]uint16, count)
		for i := range values {
			values[i] = start + uint16(i)
		}
		return values, nil
	})

	coordinator := NewCoordinator(reader)
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Address: 7, Quantity: 2}},
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Values[7] != 7 || snapshot.Values[8] != 8 {
		t.Fatalf("adapter values: %+v", snapshot.Values)
	}
}

type legacyReader struct{}

func (legacyReader) Read(_ context.Context, start, count uint16) ([]uint16, error) {
	values := make([]uint16, count)
	for i := range values {
		values[i] = start + uint16(i)
	}
	return values, nil
}

func TestReflectionReaderShape(t *testing.T) {
	coordinator := NewCoordinator(legacyReader{})
	snapshot, err := coordinator.Snapshot(context.Background(), PollPlan{
		Cycle:  time.Second,
		Ranges: []ReadRange{{Start: 3, Count: 2}},
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snapshot.Values[3] != 3 || snapshot.Values[4] != 4 {
		t.Fatalf("reflection values: %+v", snapshot.Values)
	}
}

func TestCombineReadingsRejectsConflictAndIncomplete(t *testing.T) {
	_, err := Combine([]RangeReading{
		{Range: ReadRange{Start: 0, Count: 2}, Registers: registerValues(0, 2, 1)},
		{Range: ReadRange{Start: 1, Count: 2}, Registers: []Register{{Address: 1, Value: 99}, {Address: 2, Value: 3}}},
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}

	_, err = Combine([]RangeReading{
		{Range: ReadRange{Start: 0, Count: 2}, Registers: registerValues(0, 1, 1)},
	})
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("expected incomplete, got %v", err)
	}
}

func TestInvalidRangeRejectsPlan(t *testing.T) {
	reader := ReaderFunc(func(_ context.Context, request ReadRange) ([]Register, error) {
		return registerValues(request.Start, request.Count, 0), nil
	})
	coordinator := NewCoordinator(reader)

	tests := []ReadRange{
		{Start: 0, Count: 0},
		{Start: 0xffff, Count: 2},
		{Start: 10, Address: 11, Count: 1},
	}
	for _, readRange := range tests {
		if _, err := coordinator.Snapshot(context.Background(), PollPlan{Ranges: []ReadRange{readRange}}); !errors.Is(err, ErrInvalidRange) {
			t.Fatalf("range %+v: expected invalid range, got %v", readRange, err)
		}
	}
}
