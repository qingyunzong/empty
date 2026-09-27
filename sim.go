package switchsim

// Simulator 是离散事件仿真器：事件为整数 tick 上的包到达，
// 每个 tick 先注入到达的包，再执行一次匹配调度。
type Simulator struct {
	sw       *Switch
	arrivals map[int][]Packet // tick -> 该 tick 到达的包
	now      int
	nextID   int
}

// NewSimulator 创建绑定到指定交换机的仿真器。
func NewSimulator(sw *Switch) *Simulator {
	return &Simulator{sw: sw, arrivals: make(map[int][]Packet)}
}

// AddArrival 登记计划一个到达事件：pkt 将在 tick 时刻注入交换机。
// Src/Dst/Bytes 由调用者填写，ID 与 BornTick 由仿真器赋值。
func (sim *Simulator) AddArrival(tick int, pkt Packet) {
	pkt.ID = sim.nextID
	sim.nextID++
	sim.arrivals[tick] = append(sim.arrivals[tick], pkt)
}

// Run 推进 ticks 个时隙。
func (sim *Simulator) Run(ticks int) {
	for i := 0; i < ticks; i++ {
		t := sim.now
		for _, pkt := range sim.arrivals[t] {
			sim.sw.Inject(t, pkt)
		}
		delete(sim.arrivals, t)
		sim.sw.Tick(t)
		sim.now++
	}
}

// Now 返回当前 tick。
func (sim *Simulator) Now() int { return sim.now }

// Switch 返回底层交换机。
func (sim *Simulator) Switch() *Switch { return sim.sw }
