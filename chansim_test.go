package chansim

import "testing"

func TestBufferedSendRecv(t *testing.T) {
	c := New(2)
	if !c.Send(1) || !c.Send(2) {
		t.Fatal("send on open buffered channel failed")
	}
	if v, ok := c.Recv(); !ok || v != 1 {
		t.Fatalf("got %v,%v want 1,true", v, ok)
	}
	if v, ok := c.Recv(); !ok || v != 2 {
		t.Fatalf("got %v,%v want 2,true", v, ok)
	}
}

func TestCloseDrainThenZero(t *testing.T) {
	c := New(2)
	c.Send(1)
	c.Send(2)
	c.Close()
	if v, ok := c.Recv(); !ok || v != 1 {
		t.Fatalf("drain 1: got %v,%v", v, ok)
	}
	if v, ok := c.Recv(); !ok || v != 2 {
		t.Fatalf("drain 2: got %v,%v", v, ok)
	}
	if v, ok := c.Recv(); ok || v != nil {
		t.Fatalf("closed recv: got %v,%v want nil,false", v, ok)
	}
	if c.Send(3) {
		t.Fatal("send on closed channel succeeded")
	}
	c.Close() // idempotent, must not panic
}

func TestSelectPicksLowestReadyIndex(t *testing.T) {
	a, b := New(1), New(1)
	a.Send("a")
	b.Send("b")
	if idx, v, ok := Select(Recv(a), Recv(b)); idx != 0 || v != "a" || !ok {
		t.Fatalf("both ready: got idx=%d v=%v ok=%v", idx, v, ok)
	}
	// Only b still has a value; the lower branch is not ready.
	if idx, v, ok := Select(Recv(a), Recv(b)); idx != 1 || v != "b" || !ok {
		t.Fatalf("one ready: got idx=%d v=%v ok=%v", idx, v, ok)
	}
}

func TestSelectSendBeatsLaterRecv(t *testing.T) {
	a := New(1) // send ready: buffer has space
	b := New(1)
	b.Send("x") // recv ready
	idx, _, ok := Select(Send(a, "s"), Recv(b))
	if idx != 0 || !ok {
		t.Fatalf("got idx=%d ok=%v, want send branch", idx, ok)
	}
	if v, _ := a.Recv(); v != "s" {
		t.Fatalf("a holds %v", v)
	}
}

func TestSelectClosedBranches(t *testing.T) {
	c := New(1)
	c.Close()
	idx, _, ok := Select(Send(c, 1), Recv(c))
	if idx != 0 || ok {
		t.Fatalf("send on closed: idx=%d ok=%v", idx, ok)
	}
	idx, v, ok := Select(Recv(c), Send(c, 1))
	if idx != 0 || ok || v != nil {
		t.Fatalf("recv on closed+drained: idx=%d v=%v ok=%v", idx, v, ok)
	}
}

// A blocked select that commits its receive branch must revoke its send
// branch: the send value must never appear on the channel afterwards.
func TestSelectRevokesSendBranch(t *testing.T) {
	a := New(0)
	b := New(0)
	o := startOp([]Case{Send(a, "x"), Recv(b)})
	if o.chosen >= 0 {
		t.Fatal("select should have blocked")
	}
	if !b.Send("y") {
		t.Fatal("handoff send failed")
	}
	if o.chosen != 1 || o.res.val != "y" || !o.res.ok {
		t.Fatalf("select committed %+v", o.res)
	}
	if len(a.sendQ) != 0 {
		t.Fatal("revoked send branch still registered")
	}
	// No ghost: a receive on a must block because "x" was revoked.
	probe := startOp([]Case{Recv(a)})
	if probe.chosen >= 0 {
		t.Fatalf("ghost send delivered %v", probe.res.val)
	}
}

// A blocked select whose send branch fails via Close must revoke its
// receive branch.
func TestSelectSendFailsOnClose(t *testing.T) {
	a := New(0)
	b := New(0)
	o := startOp([]Case{Send(a, "x"), Recv(b)})
	a.Close()
	if o.chosen != 0 || o.res.ok {
		t.Fatalf("select committed %+v", o.res)
	}
	if len(b.recvQ) != 0 {
		t.Fatal("revoked recv branch still registered")
	}
	probe := startOp([]Case{Send(b, "z")})
	if probe.chosen >= 0 {
		t.Fatal("ghost receiver consumed send")
	}
}

func TestUnbufferedHandoff(t *testing.T) {
	c := New(0)
	go c.Send(42)
	if v, ok := c.Recv(); !ok || v != 42 {
		t.Fatalf("got %v,%v", v, ok)
	}
}

func TestConcurrentSelectLoop(t *testing.T) {
	a, b := New(2), New(0)
	go func() {
		for i := 0; i < 50; i++ {
			a.Send(i)
		}
		a.Close()
	}()
	go func() {
		for i := 0; i < 50; i++ {
			b.Send(i)
		}
		b.Close()
	}()
	openA, openB, got := true, true, 0
	for openA || openB {
		idx, _, ok := Select(Recv(a), Recv(b))
		if !ok {
			if idx == 0 {
				openA = false
			} else {
				openB = false
			}
			continue
		}
		got++
	}
	if got != 100 {
		t.Fatalf("received %d values, want 100", got)
	}
}
