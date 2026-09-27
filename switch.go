// Package switchsim 是一个多入口多出口交换机的离散事件仿真。
// 时间为整数 tick，每 tick 每端口至多发送一个包，不涉及真实网络流量。
package switchsim

import "fmt"

// Mode 选择输入队列组织方式。
type Mode int

const (
	// ModeFIFO 每个入口单一 FIFO 队列，存在队首阻塞（HOL blocking）。
	ModeFIFO Mode = iota
	// ModeVOQ 每个入口按出口划分虚拟输出队列，消除队首阻塞。
	ModeVOQ
)

func (m Mode) String() string {
	if m == ModeVOQ {
		return "VOQ"
	}
	return "FIFO(HOL)"
}

// Packet 是仿真中的数据包，只携带元数据，不携带真实载荷。
type Packet struct {
	ID       int
	Src      int // 入口端口
	Dst      int // 出口端口
	Bytes    int
	BornTick int // 进入交换机的 tick
}

// Config 是交换机配置。
type Config struct {
	Ports    int  // 入口/出口端口数（N×N）
	Mode     Mode // FIFO 或 VOQ
	QueueCap int  // 每个队列的最大包数，超出即丢弃
}

// Stats 记录收、发（注入）、丢三类的包数与字节数。
type Stats struct {
	Injected      int64 // 注入交换机的包数
	Received      int64 // 成功送达出口的包数
	Dropped       int64 // 因队列满被丢弃的包数
	InjectedBytes int64
	ReceivedBytes int64
	DroppedBytes  int64
	LatencySum    int64 // 所有已收包的排队时延之和（tick）
}

// AvgLatency 返回已收包的平均时延（tick）。
func (s Stats) AvgLatency() float64 {
	if s.Received == 0 {
		return 0
	}
	return float64(s.LatencySum) / float64(s.Received)
}

// queue 是简单的包队列。
type queue struct {
	pkts []Packet
}

func (q *queue) len() int      { return len(q.pkts) }
func (q *queue) push(p Packet) { q.pkts = append(q.pkts, p) }
func (q *queue) head() Packet  { return q.pkts[0] }
func (q *queue) pop() Packet   { p := q.pkts[0]; q.pkts = q.pkts[1:]; return p }

// Switch 是 N×N 交换机模型。
type Switch struct {
	cfg Config

	// FIFO 模式：queues[in][0] 为该入口唯一队列；
	// VOQ 模式：queues[in][out] 为入口 in 到出口 out 的虚拟输出队列。
	queues [][]queue

	priority int // 匹配调度的轮转优先级起点

	queuedPkts  int64 // 当前仍在交换机内的包数
	queuedBytes int64 // 当前仍在交换机内的字节数

	// OnDeliver 可选回调：每次有包送达出口时触发，用于观测逐 tick 行为。
	OnDeliver func(tick int, pkt Packet)

	Stats Stats
}

// New 创建交换机。
func New(cfg Config) *Switch {
	if cfg.Ports < 1 {
		panic("switchsim: Ports must be >= 1")
	}
	if cfg.QueueCap < 1 {
		cfg.QueueCap = 1
	}
	s := &Switch{cfg: cfg}
	n := cfg.Ports
	s.queues = make([][]queue, n)
	width := n
	if cfg.Mode == ModeFIFO {
		width = 1
	}
	for i := range s.queues {
		s.queues[i] = make([]queue, width)
	}
	return s
}

// Inject 在 tick 时刻把一个包注入入口队列；队列满则丢弃并计数。
func (s *Switch) Inject(tick int, pkt Packet) {
	pkt.BornTick = tick
	s.Stats.Injected++
	s.Stats.InjectedBytes += int64(pkt.Bytes)
	q := s.queueFor(pkt.Src, pkt.Dst)
	if q.len() >= s.cfg.QueueCap {
		s.Stats.Dropped++
		s.Stats.DroppedBytes += int64(pkt.Bytes)
		return
	}
	q.push(pkt)
	s.queuedPkts++
	s.queuedBytes += int64(pkt.Bytes)
}

func (s *Switch) queueFor(in, out int) *queue {
	if s.cfg.Mode == ModeFIFO {
		return &s.queues[in][0]
	}
	return &s.queues[in][out]
}

// hasRequest 报告入口 in 是否有发往出口 out 的待发包。
func (s *Switch) hasRequest(in, out int) bool {
	if s.cfg.Mode == ModeFIFO {
		q := &s.queues[in][0]
		return q.len() > 0 && q.head().Dst == out
	}
	return s.queues[in][out].len() > 0
}

// dequeue 取出匹配成功后要发送的包。
func (s *Switch) dequeue(in, out int) Packet {
	q := s.queueFor(in, out)
	pkt := q.pop()
	s.queuedPkts--
	s.queuedBytes -= int64(pkt.Bytes)
	return pkt
}

// match 计算本 tick 的输入-输出匹配。
// 采用轮转优先级的贪心最大匹配：每个出口按轮转顺序挑选一个空闲入口，
// 保证任意未被满足的请求必因其入口或出口已被占用（最大性），
// 因此无竞争的出口总能推进，争同一出口的入口每 tick 至多一个获准。
func (s *Switch) match() [][2]int {
	n := s.cfg.Ports
	inBusy := make([]bool, n)
	outBusy := make([]bool, n)
	var grants [][2]int
	start := s.priority
	for k := 0; k < n; k++ {
		out := (start + k) % n
		for j := 0; j < n; j++ {
			in := (start + j) % n
			if inBusy[in] || outBusy[out] {
				continue
			}
			if s.hasRequest(in, out) {
				inBusy[in] = true
				outBusy[out] = true
				grants = append(grants, [2]int{in, out})
				break
			}
		}
	}
	s.priority = (start + 1) % n
	return grants
}

// Tick 推进一个时隙：按匹配结果发送包并送达出口。
func (s *Switch) Tick(tick int) {
	for _, g := range s.match() {
		pkt := s.dequeue(g[0], g[1])
		s.Stats.Received++
		s.Stats.ReceivedBytes += int64(pkt.Bytes)
		s.Stats.LatencySum += int64(tick - pkt.BornTick)
		if s.OnDeliver != nil {
			s.OnDeliver(tick, pkt)
		}
	}
}

// QueuedPkts 返回当前仍在交换机内排队的包数。
func (s *Switch) QueuedPkts() int64 { return s.queuedPkts }

// QueuedBytes 返回当前仍在交换机内排队的字节数。
func (s *Switch) QueuedBytes() int64 { return s.queuedBytes }

// CheckConservation 校验字节与包的守恒：
// 注入 = 已收 + 已丢 + 仍在队列中。
func (s *Switch) CheckConservation() error {
	st := s.Stats
	if st.Injected != st.Received+st.Dropped+s.queuedPkts {
		return fmt.Errorf("packet conservation violated: injected=%d received=%d dropped=%d queued=%d",
			st.Injected, st.Received, st.Dropped, s.queuedPkts)
	}
	if st.InjectedBytes != st.ReceivedBytes+st.DroppedBytes+s.queuedBytes {
		return fmt.Errorf("byte conservation violated: injected=%d received=%d dropped=%d queued=%d",
			st.InjectedBytes, st.ReceivedBytes, st.DroppedBytes, s.queuedBytes)
	}
	return nil
}
