package msglib

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

// model is a full-knowledge causal reference model. It records every sent
// message and every message each node has accepted, and recomputes from
// scratch what the library's incremental state must be.
type model struct {
	n        int
	sent     map[MessageID]Message
	accepted []map[MessageID]Message
}

func newModel(n int) *model {
	m := &model{n: n, sent: make(map[MessageID]Message), accepted: make([]map[MessageID]Message, n)}
	for i := range m.accepted {
		m.accepted[i] = make(map[MessageID]Message)
	}
	return m
}

// deliveredVector recomputes the causal prefix of the accepted messages:
// the receive vector the library must hold for the node.
func (m *model) deliveredVector(node int) Vector {
	clock := make(Vector, m.n)
	for {
		progress := false
		for id, msg := range m.accepted[node] {
			if msg.VT[id.Sender] != clock[id.Sender]+1 {
				continue
			}
			ready := true
			for j := 0; j < m.n; j++ {
				if j != id.Sender && msg.VT[j] > clock[j] {
					ready = false
					break
				}
			}
			if ready {
				clock[id.Sender]++
				progress = true
			}
		}
		if !progress {
			return clock
		}
	}
}

// pendingBytes is the exact memory the library must report: payload bytes of
// accepted messages beyond the delivered prefix.
func (m *model) pendingBytes(node int) uint64 {
	clock := m.deliveredVector(node)
	var total uint64
	for id, msg := range m.accepted[node] {
		if msg.VT[id.Sender] > clock[id.Sender] {
			total += uint64(len(msg.Payload))
		}
	}
	return total
}

func checkInvariants(t *testing.T, nodes []*Node, mdl *model) {
	t.Helper()
	for i, nd := range nodes {
		// Budget conservation: accounted bytes equal the exact payload bytes
		// of accepted-but-undelivered messages, and never exceed the limit.
		if got, want := nd.Used(), mdl.pendingBytes(i); got != want {
			t.Fatalf("node %d: Used = %d, model wants %d (budget not conserved)", i, got, want)
		}
		if nd.Used() > nd.Limit() {
			t.Fatalf("node %d: Used %d exceeds limit %d", i, nd.Used(), nd.Limit())
		}
		// The receive vector must match the full causal model.
		vec := nd.Vector()
		if want := mdl.deliveredVector(i); !reflect.DeepEqual(vec, want) {
			t.Fatalf("node %d: Vector = %v, model wants %v", i, vec, want)
		}
		// Causal closure: every delivered message has all dependencies
		// delivered.
		for id, msg := range mdl.accepted[i] {
			if msg.VT[id.Sender] > vec[id.Sender] {
				continue
			}
			for j := range vec {
				if msg.VT[j] > vec[j] {
					t.Fatalf("node %d: delivered %v without dependency %d:%d", i, id, j, msg.VT[j])
				}
			}
		}
	}
}

// TestRandomizedModelCrossCheck drives random sends and receives against the
// library and cross-checks every observable against the full causal model:
// budget conservation, receive vectors, rejection semantics, and causal
// delivery order.
func TestRandomizedModelCrossCheck(t *testing.T) {
	const (
		numNodes   = 4
		numOps     = 20000
		budget     = 64
		maxPayload = 24
	)
	rng := rand.New(rand.NewSource(1))
	nodes := make([]*Node, numNodes)
	for i := range nodes {
		nodes[i] = NewNode(i, numNodes, budget)
	}
	mdl := newModel(numNodes)
	var sentList []MessageID
	rejections := 0

	for op := 0; op < numOps; op++ {
		if len(sentList) == 0 || rng.Intn(3) == 0 {
			from := rng.Intn(numNodes)
			payload := make([]byte, 1+rng.Intn(maxPayload))
			rng.Read(payload)
			msg := nodes[from].Send(payload)
			mdl.sent[msg.ID] = msg
			mdl.accepted[from][msg.ID] = msg // own sends are locally delivered
			sentList = append(sentList, msg.ID)
			continue
		}
		to := rng.Intn(numNodes)
		id := sentList[rng.Intn(len(sentList))]
		msg := mdl.sent[id]

		beforeVec := nodes[to].Vector()
		beforeUsed := nodes[to].Used()
		delivered, err := nodes[to].Receive(msg)

		if err != nil {
			if !errors.Is(err, ErrOverBudget) {
				t.Fatalf("op %d: unexpected error: %v", op, err)
			}
			// Rejection must not advance the receive vector or accounting.
			if !reflect.DeepEqual(nodes[to].Vector(), beforeVec) {
				t.Fatalf("op %d: receive vector advanced on rejection", op)
			}
			if nodes[to].Used() != beforeUsed {
				t.Fatalf("op %d: Used changed on rejection", op)
			}
			rejections++
			continue
		}
		if _, dup := mdl.accepted[to][id]; dup {
			if len(delivered) != 0 {
				t.Fatalf("op %d: duplicate receive delivered messages", op)
			}
			continue
		}
		mdl.accepted[to][id] = msg

		// Delivered messages must form a valid causal linearization.
		vec := beforeVec.Clone()
		for _, d := range delivered {
			if d.VT[d.ID.Sender] != vec[d.ID.Sender]+1 {
				t.Fatalf("op %d: delivered %v out of causal order", op, d.ID)
			}
			for j := 0; j < numNodes; j++ {
				if j != d.ID.Sender && d.VT[j] > vec[j] {
					t.Fatalf("op %d: delivered %v with unmet dependency %d:%d", op, d.ID, j, d.VT[j])
				}
			}
			vec[d.ID.Sender]++
		}

		if op%97 == 0 {
			checkInvariants(t, nodes, mdl)
		}
	}
	checkInvariants(t, nodes, mdl)
	t.Logf("ops=%d rejections=%d sent=%d", numOps, rejections, len(sentList))
	if rejections == 0 {
		t.Fatal("budget rejections were never exercised")
	}
}

// TestRandomizedDrainReleasesAllMemory verifies that once every message
// reaches every node, all memory is released: nothing leaks.
func TestRandomizedDrainReleasesAllMemory(t *testing.T) {
	const (
		numNodes   = 3
		numOps     = 5000
		maxPayload = 32
	)
	rng := rand.New(rand.NewSource(2))
	nodes := make([]*Node, numNodes)
	for i := range nodes {
		nodes[i] = NewNode(i, numNodes, 1<<20) // budget never binds
	}
	mdl := newModel(numNodes)
	var sentList []MessageID

	for op := 0; op < numOps; op++ {
		if len(sentList) == 0 || rng.Intn(2) == 0 {
			from := rng.Intn(numNodes)
			payload := make([]byte, 1+rng.Intn(maxPayload))
			rng.Read(payload)
			msg := nodes[from].Send(payload)
			mdl.sent[msg.ID] = msg
			mdl.accepted[from][msg.ID] = msg
			sentList = append(sentList, msg.ID)
			continue
		}
		to := rng.Intn(numNodes)
		msg := mdl.sent[sentList[rng.Intn(len(sentList))]]
		if _, err := nodes[to].Receive(msg); err != nil {
			t.Fatalf("op %d: unexpected rejection with ample budget: %v", op, err)
		}
		mdl.accepted[to][msg.ID] = msg
	}

	// Flush: every node receives every sent message.
	for _, id := range sentList {
		for to, nd := range nodes {
			msg := mdl.sent[id]
			if _, err := nd.Receive(msg); err != nil {
				t.Fatalf("flush: unexpected error: %v", err)
			}
			mdl.accepted[to][msg.ID] = msg
		}
	}

	want := make(Vector, numNodes)
	for id := range mdl.sent {
		want[id.Sender]++
	}
	for i, nd := range nodes {
		if got := nd.Used(); got != 0 {
			t.Fatalf("node %d: leaked %d bytes after full delivery", i, got)
		}
		if !reflect.DeepEqual(nd.Vector(), want) {
			t.Fatalf("node %d: Vector = %v, want %v", i, nd.Vector(), want)
		}
		if got := nd.Pending(); len(got) != 0 {
			t.Fatalf("node %d: %d messages still pending", i, len(got))
		}
	}
	checkInvariants(t, nodes, mdl)
}
