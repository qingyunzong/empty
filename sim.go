package main

import "container/heap"

// Tick 是离散事件模型的整数时间单位。
type Tick int

// PacketState 是包的最终/中间状态。
type PacketState string

const (
	StatePending   PacketState = "pending"    // 已创建，发送事件尚未到达
	StateQueued    PacketState = "queued"     // 在队列中等待发出（未发包）
	StateInTransit PacketState = "in_transit" // 在途
	StatePaused    PacketState = "paused"     // 在途但被暂停故障冻结
	StateDelivered PacketState = "delivered"
	StateDropped   PacketState = "dropped"
)

// Policy 是故障生效期间链路的处置策略，在故障开始时固定。
type Policy int

const (
	PolicyPause Policy = iota // 暂停：在途包冻结，队列停止发出，恢复后继续
	PolicyDrop                // 丢弃：在途包丢弃，故障期间发出的包也丢弃
	PolicyDelay               // 延迟：在途包与新发包额外延迟 delayTicks
)

func (p Policy) String() string {
	switch p {
	case PolicyPause:
		return "pause"
	case PolicyDrop:
		return "drop"
	case PolicyDelay:
		return "delay"
	}
	return "unknown"
}

// Packet 是被模拟的包。Dropped 的包永远不会复活。
type Packet struct {
	ID          int
	State       PacketState
	DeliveredAt Tick // 仅当 State == delivered 有效
	DroppedAt   Tick // 仅当 State == dropped 有效

	deliverAt Tick // 在途时预计送达 tick（延迟故障会改写它，使旧事件失效）
	remaining Tick // 暂停时剩余的在途 tick
}

type eventKind int

const (
	evSend eventKind = iota
	evFaultStart
	evRecover
	evService
	evDeliver
)

type event struct {
	tick   Tick
	seq    int // 同 tick 按调度先后排序，保证确定性
	kind   eventKind
	link   *Link
	pkt    *Packet
	policy Policy
}

type eventHeap []event

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].tick != h[j].tick {
		return h[i].tick < h[j].tick
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x interface{}) {
	*h = append(*h, x.(event))
}
func (h *eventHeap) Pop() interface{} {
	old := *h
	n := len(old)
	e := old[n-1]
	*h = old[:n-1]
	return e
}

// Link 是带发送队列和有限速率的链路。
type Link struct {
	name       string
	latency    Tick // 在途基础时延
	rate       int  // 每 tick 最多发出的包数
	delayTicks Tick // delay 策略施加的额外时延

	queue     []*Packet
	inTransit map[*Packet]bool
	paused    map[*Packet]bool

	faultActive bool
	policy      Policy // 故障开始时固定，故障期间不变

	servicePending bool
	lastService    Tick
}

func (l *Link) kick(s *Simulator, t Tick) {
	if len(l.queue) > 0 && !l.servicePending {
		l.servicePending = true
		s.schedule(t, evService, l, nil, 0)
	}
}

func (l *Link) onSend(s *Simulator, p *Packet, t Tick) {
	p.State = StateQueued
	l.queue = append(l.queue, p)
	l.kick(s, t)
}

// onService 每 tick 最多执行一次，按 rate 从队列发出包。
func (l *Link) onService(s *Simulator, t Tick) {
	l.servicePending = false
	if t == l.lastService {
		return
	}
	l.lastService = t
	if l.faultActive && l.policy == PolicyPause {
		return // 暂停：队列冻结，等恢复
	}
	for departed := 0; departed < l.rate && len(l.queue) > 0; departed++ {
		p := l.queue[0]
		l.queue = l.queue[1:]
		if l.faultActive && l.policy == PolicyDrop {
			l.drop(p, t)
			continue
		}
		extra := Tick(0)
		if l.faultActive && l.policy == PolicyDelay {
			extra = l.delayTicks
		}
		p.State = StateInTransit
		p.deliverAt = t + l.latency + extra
		l.inTransit[p] = true
		s.schedule(p.deliverAt, evDeliver, l, p, 0)
	}
	if len(l.queue) > 0 {
		l.servicePending = true
		s.schedule(t+1, evService, l, nil, 0)
	}
}

func (l *Link) onDeliver(s *Simulator, p *Packet, t Tick) {
	// 过期事件（包已被暂停/丢弃/重新排期）直接忽略。
	if p.State != StateInTransit || p.deliverAt != t {
		return
	}
	p.State = StateDelivered
	p.DeliveredAt = t
	delete(l.inTransit, p)
}

func (l *Link) drop(p *Packet, t Tick) {
	p.State = StateDropped
	p.DroppedAt = t
	delete(l.inTransit, p)
}

func (l *Link) onFaultStart(s *Simulator, policy Policy, t Tick) {
	if l.faultActive {
		return // 重复故障事件幂等；策略保持首次故障开始时的值
	}
	l.faultActive = true
	l.policy = policy
	switch policy {
	case PolicyPause:
		for p := range l.inTransit {
			p.remaining = p.deliverAt - t
			p.State = StatePaused
			l.paused[p] = true
		}
		l.inTransit = map[*Packet]bool{}
	case PolicyDrop:
		for p := range l.inTransit {
			l.drop(p, t)
		}
	case PolicyDelay:
		for p := range l.inTransit {
			p.deliverAt += l.delayTicks
			s.schedule(p.deliverAt, evDeliver, l, p, 0)
		}
	}
}

func (l *Link) onRecover(s *Simulator, t Tick) {
	if !l.faultActive {
		return // 重复恢复事件幂等
	}
	l.faultActive = false
	// 只恢复被暂停的在途包；已丢弃的包不参与，不会复活。
	for p := range l.paused {
		p.State = StateInTransit
		p.deliverAt = t + p.remaining
		l.inTransit[p] = true
		s.schedule(p.deliverAt, evDeliver, l, p, 0)
	}
	l.paused = map[*Packet]bool{}
	l.kick(s, t) // 队列按规则继续发出
}

// Simulator 是离散事件模拟器：整数 tick，事件最小堆驱动。
type Simulator struct {
	now     Tick
	ev      eventHeap
	seq     int
	packets []*Packet
	links   []*Link
}

func NewSimulator() *Simulator { return &Simulator{} }

func (s *Simulator) schedule(tick Tick, kind eventKind, l *Link, p *Packet, pol Policy) {
	heap.Push(&s.ev, event{tick: tick, seq: s.seq, kind: kind, link: l, pkt: p, policy: pol})
	s.seq++
}

func (s *Simulator) AddLink(name string, latency Tick, rate int, delayTicks Tick) *Link {
	l := &Link{
		name:        name,
		latency:     latency,
		rate:        rate,
		delayTicks:  delayTicks,
		inTransit:   map[*Packet]bool{},
		paused:      map[*Packet]bool{},
		lastService: -1,
	}
	s.links = append(s.links, l)
	return l
}

// Send 在指定 tick 向链路提交一个包。
func (s *Simulator) Send(tick Tick, l *Link, id int) *Packet {
	p := &Packet{ID: id, State: StatePending}
	s.packets = append(s.packets, p)
	s.schedule(tick, evSend, l, p, 0)
	return p
}

// Fault 在指定 tick 让链路进入故障，策略在此时固定。
func (s *Simulator) Fault(tick Tick, l *Link, pol Policy) {
	s.schedule(tick, evFaultStart, l, nil, pol)
}

// Recover 在指定 tick 让链路恢复。
func (s *Simulator) Recover(tick Tick, l *Link) {
	s.schedule(tick, evRecover, l, nil, 0)
}

// Run 处理所有事件直到事件堆为空。
func (s *Simulator) Run() {
	for len(s.ev) > 0 {
		e := heap.Pop(&s.ev).(event)
		s.now = e.tick
		switch e.kind {
		case evSend:
			e.link.onSend(s, e.pkt, e.tick)
		case evFaultStart:
			e.link.onFaultStart(s, e.policy, e.tick)
		case evRecover:
			e.link.onRecover(s, e.tick)
		case evService:
			e.link.onService(s, e.tick)
		case evDeliver:
			e.link.onDeliver(s, e.pkt, e.tick)
		}
	}
}

// Packets 按提交顺序返回所有包，用于输出最终状态。
func (s *Simulator) Packets() []*Packet { return s.packets }
