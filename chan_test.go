package chansim

import (
	"sync"
	"testing"
	"time"
)

func TestBufferedSendRecvFIFO(t *testing.T) {
	c := New(2)
	if !c.Send(1) || !c.Send(2) {
		t.Fatal("send into empty buffered channel failed")
	}
	if c.Len() != 2 {
		t.Fatalf("Len = %d, want 2", c.Len())
	}
	if v, ok := c.Recv(); !ok || v != 1 {
		t.Fatalf("Recv = %v,%v, want 1,true", v, ok)
	}
	if v, ok := c.Recv(); !ok || v != 2 {
		t.Fatalf("Recv = %v,%v, want 2,true", v, ok)
	}
}

func TestSendBlocksUntilSpace(t *testing.T) {
	c := New(1)
	c.Send(1)
	done := make(chan bool, 1)
	go func() { done <- c.Send(2) }()
	select {
	case <-done:
		t.Fatal("send committed while buffer full")
	case <-time.After(50 * time.Millisecond):
	}
	if v, ok := c.Recv(); !ok || v != 1 {
		t.Fatalf("Recv = %v,%v", v, ok)
	}
	if !<-done {
		t.Fatal("send reported failure on open channel")
	}
	if v, ok := c.Recv(); !ok || v != 2 {
		t.Fatalf("Recv = %v,%v, want 2,true", v, ok)
	}
}

func TestRecvBlocksUntilSend(t *testing.T) {
	c := New(1)
	got := make(chan any, 1)
	go func() {
		v, _ := c.Recv()
		got <- v
	}()
	time.Sleep(50 * time.Millisecond)
	c.Send(42)
	if v := <-got; v != 42 {
		t.Fatalf("received %v, want 42", v)
	}
}

func TestCloseDrainThenZero(t *testing.T) {
	c := New(2)
	c.Send("a")
	c.Send("b")
	c.Close()
	if v, ok := c.Recv(); !ok || v != "a" {
		t.Fatalf("drain 1 = %v,%v", v, ok)
	}
	if v, ok := c.Recv(); !ok || v != "b" {
		t.Fatalf("drain 2 = %v,%v", v, ok)
	}
	for i := 0; i < 3; i++ {
		if v, ok := c.Recv(); ok || v != nil {
			t.Fatalf("recv on drained closed channel = %v,%v, want nil,false", v, ok)
		}
	}
}

func TestSendOnClosedFails(t *testing.T) {
	c := New(1)
	c.Close()
	if c.Send(1) {
		t.Fatal("send on closed channel succeeded")
	}
	if c.TrySend(1) {
		t.Fatal("TrySend on closed channel succeeded")
	}
}

func TestBlockedSendFailsOnClose(t *testing.T) {
	c := New(1)
	c.Send(1) // fill buffer so the next send blocks
	done := make(chan bool, 1)
	go func() { done <- c.Send(2) }()
	time.Sleep(50 * time.Millisecond)
	c.Close()
	if <-done {
		t.Fatal("blocked send succeeded after close")
	}
}

func TestUnbufferedRendezvous(t *testing.T) {
	c := New(0)
	if c.TrySend(1) {
		t.Fatal("cap-0 send committed with no waiting receiver")
	}
	got := make(chan any, 1)
	go func() {
		v, _ := c.Recv()
		got <- v
	}()
	time.Sleep(50 * time.Millisecond) // let the receiver block
	if !c.Send(7) {
		t.Fatal("rendezvous send failed")
	}
	if v := <-got; v != 7 {
		t.Fatalf("received %v, want 7", v)
	}
}

func TestSelectSmallestIndexWins(t *testing.T) {
	c0, c1 := New(1), New(1)
	c0.Send("x")
	c1.Send("y")
	idx, v, ok := Select(RecvCase(c0), RecvCase(c1))
	if idx != 0 || v != "x" || !ok {
		t.Fatalf("Select = %d,%v,%v, want 0,x,true", idx, v, ok)
	}
	// Both send branches ready: smallest index must win too.
	d0, d1 := New(1), New(1)
	idx, _, ok = Select(SendCase(d0, 1), SendCase(d1, 2))
	if idx != 0 || !ok {
		t.Fatalf("Select = %d,_,%v, want 0,_,true", idx, ok)
	}
	if d0.Len() != 1 || d1.Len() != 0 {
		t.Fatalf("d0.Len=%d d1.Len=%d, want 1,0", d0.Len(), d1.Len())
	}
}

func TestSelectSingleCommitNoGhost(t *testing.T) {
	// Send branch wins: the losing receive branch must stay untouched.
	c0, c1 := New(1), New(1)
	c1.Send("kept")
	idx, _, _ := Select(SendCase(c0, "sent"), RecvCase(c1))
	if idx != 0 {
		t.Fatalf("Select picked %d, want 0", idx)
	}
	if v, _ := c1.Recv(); v != "kept" {
		t.Fatalf("c1 lost its value: %v", v)
	}
	if v, _ := c0.Recv(); v != "sent" {
		t.Fatalf("c0 = %v, want sent", v)
	}

	// Receive branch wins: the losing send branch must not commit (no ghost).
	c0, c1 = New(1), New(1)
	c1.Send("real")
	idx, v, ok := Select(RecvCase(c1), SendCase(c0, "ghost"))
	if idx != 0 || v != "real" || !ok {
		t.Fatalf("Select = %d,%v,%v, want 0,real,true", idx, v, ok)
	}
	if c0.Len() != 0 {
		t.Fatalf("ghost send committed: c0.Len() = %d", c0.Len())
	}
	if v, ok := c0.TryRecv(); ok || v != nil {
		t.Fatalf("ghost value received: %v,%v", v, ok)
	}
}

func TestSelectBlocksAndRevokesRegistrations(t *testing.T) {
	c0, c1 := New(0), New(0) // rendezvous: readiness depends on nwait
	res := make(chan int, 1)
	go func() {
		idx, _, _ := Select(RecvCase(c0), RecvCase(c1))
		res <- idx
	}()
	time.Sleep(50 * time.Millisecond)
	// The blocked select registered as a receiver on both channels.
	mu.Lock()
	n0, n1 := c0.nwait, c1.nwait
	mu.Unlock()
	if n0 != 1 || n1 != 1 {
		t.Fatalf("nwait = %d,%d, want 1,1", n0, n1)
	}
	if !c1.Send(9) {
		t.Fatal("rendezvous send to blocked select failed")
	}
	if idx := <-res; idx != 1 {
		t.Fatalf("Select picked %d, want 1", idx)
	}
	// All registrations revoked after the single commit.
	mu.Lock()
	n0, n1 = c0.nwait, c1.nwait
	mu.Unlock()
	if n0 != 0 || n1 != 0 {
		t.Fatalf("registrations not revoked: nwait = %d,%d", n0, n1)
	}
}

func TestSelectRecvOnClosed(t *testing.T) {
	c := New(1)
	c.Close()
	idx, v, ok := Select(RecvCase(c))
	if idx != 0 || v != nil || ok {
		t.Fatalf("Select on closed = %d,%v,%v, want 0,nil,false", idx, v, ok)
	}
}

func TestSelectSendOnClosedNeverChosen(t *testing.T) {
	c := New(1)
	c.Close()
	if idx, _, _ := SelectNow(SendCase(c, 1)); idx != -1 {
		t.Fatalf("SelectNow picked send-on-closed branch %d", idx)
	}
}

func TestConcurrentNoGhost(t *testing.T) {
	const n = 200
	c0, c1 := New(3), New(0)
	var wg sync.WaitGroup
	var mu sync.Mutex
	sent := map[int]int{}
	recvd := map[int]int{}

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < n; i++ {
				v := w*n + i
				idx, _, _ := Select(SendCase(c0, v), SendCase(c1, v))
				mu.Lock()
				sent[v]++
				mu.Unlock()
				_ = idx
			}
		}(w)
	}
	for r := 0; r < 2; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cases := []Case{RecvCase(c0), RecvCase(c1)}
			for len(cases) > 0 {
				idx, v, ok := Select(cases...)
				if !ok {
					// Channel closed and drained: drop the dead branch.
					cases = append(cases[:idx], cases[idx+1:]...)
					continue
				}
				mu.Lock()
				recvd[v.(int)]++
				mu.Unlock()
			}
		}()
	}
	// Wait for senders, then close both channels to release receivers.
	go func() {
		for {
			time.Sleep(5 * time.Millisecond)
			mu.Lock()
			done := len(sent) == 4*n
			mu.Unlock()
			if done {
				// Drain may still be in progress; close once buffers empty.
				for c0.Len()+c1.Len() > 0 {
					time.Sleep(time.Millisecond)
				}
				c0.Close()
				c1.Close()
				return
			}
		}
	}()
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	for v, cnt := range sent {
		if cnt != 1 {
			t.Fatalf("value %d sent %d times", v, cnt)
		}
		if recvd[v] != 1 {
			t.Fatalf("value %d received %d times, want 1", v, recvd[v])
		}
	}
	for v, cnt := range recvd {
		if cnt != 1 {
			t.Fatalf("value %d received %d times", v, cnt)
		}
		if sent[v] != 1 {
			t.Fatalf("ghost receive of never-sent value %d", v)
		}
	}
}
