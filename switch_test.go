package switchsim

import (
	"math/rand"
	"testing"
)

// 两个入口争同一出口：每 tick 至多放行一个，两个包需要两个 tick。
func TestContentionSameOutput(t *testing.T) {
	for _, mode := range []Mode{ModeFIFO, ModeVOQ} {
		sw := New(Config{Ports: 2, Mode: mode, QueueCap: 8})
		sim := NewSimulator(sw)
		sim.AddArrival(0, Packet{Src: 0, Dst: 0, Bytes: 100})
		sim.AddArrival(0, Packet{Src: 1, Dst: 0, Bytes: 100})
		sim.Run(1)
		if got := sw.Stats.Received; got != 1 {
			t.Fatalf("%v: after 1 tick received=%d, want 1", mode, got)
		}
		sim.Run(1)
		if got := sw.Stats.Received; got != 2 {
			t.Fatalf("%v: after 2 ticks received=%d, want 2", mode, got)
		}
	}
}

// 无竞争的出口应在同一 tick 一起推进。
func TestUncontestedProgress(t *testing.T) {
	for _, mode := range []Mode{ModeFIFO, ModeVOQ} {
		sw := New(Config{Ports: 2, Mode: mode, QueueCap: 8})
		sim := NewSimulator(sw)
		sim.AddArrival(0, Packet{Src: 0, Dst: 0, Bytes: 64})
		sim.AddArrival(0, Packet{Src: 1, Dst: 1, Bytes: 64})
		sim.Run(1)
		if got := sw.Stats.Received; got != 2 {
			t.Fatalf("%v: received=%d after 1 tick, want 2 (uncontested outputs must progress)", mode, got)
		}
	}
}

// 队首阻塞场景：入口1 的队首 A 去出口0、次包 B 去出口1；入口0 的包 C 去出口0。
// tick0 仲裁中 C 获胜，A 滞留队首并阻塞 B（FIFO）；VOQ 中 B 不受牵连。
// FIFO 需要 3 个 tick 送完，VOQ 只需 2 个。
func TestVOQAvoidsHOLBlocking(t *testing.T) {
	build := func(mode Mode) *Simulator {
		sw := New(Config{Ports: 2, Mode: mode, QueueCap: 8})
		sim := NewSimulator(sw)
		sim.AddArrival(0, Packet{Src: 1, Dst: 0, Bytes: 64}) // A
		sim.AddArrival(0, Packet{Src: 1, Dst: 1, Bytes: 64}) // B，FIFO 下被 A 阻塞
		sim.AddArrival(0, Packet{Src: 0, Dst: 0, Bytes: 64}) // C，tick0 赢得出口0
		return sim
	}

	fifo := build(ModeFIFO)
	fifo.Run(2)
	voq := build(ModeVOQ)
	voq.Run(2)

	if got := fifo.Switch().Stats.Received; got != 2 {
		t.Fatalf("FIFO: received=%d after 2 ticks, want 2 (HOL blocking)", got)
	}
	if got := voq.Switch().Stats.Received; got != 3 {
		t.Fatalf("VOQ: received=%d after 2 ticks, want 3 (no HOL blocking)", got)
	}

	fifo.Run(1)
	if got := fifo.Switch().Stats.Received; got != 3 {
		t.Fatalf("FIFO: received=%d after 3 ticks, want 3", got)
	}
}

// 队列容量有限时，超出的包被丢弃并计入丢包统计。
func TestQueueCapacityDrops(t *testing.T) {
	sw := New(Config{Ports: 2, Mode: ModeVOQ, QueueCap: 1})
	sim := NewSimulator(sw)
	for i := 0; i < 3; i++ {
		sim.AddArrival(0, Packet{Src: 0, Dst: 0, Bytes: 100})
	}
	sim.Run(1)
	st := sw.Stats
	if st.Dropped != 2 || st.DroppedBytes != 200 {
		t.Fatalf("dropped=%d/%dB, want 2/200B", st.Dropped, st.DroppedBytes)
	}
	if st.Received != 1 {
		t.Fatalf("received=%d, want 1", st.Received)
	}
}

// 随机流量下，任意时刻都满足：注入 = 已收 + 已丢 + 队列中（包数与字节数）。
func TestConservationUnderRandomTraffic(t *testing.T) {
	for _, mode := range []Mode{ModeFIFO, ModeVOQ} {
		sw := New(Config{Ports: 4, Mode: mode, QueueCap: 3})
		sim := NewSimulator(sw)
		rng := rand.New(rand.NewSource(7))
		for tick := 0; tick < 50; tick++ {
			for in := 0; in < 4; in++ {
				if rng.Float64() < 0.8 {
					sim.AddArrival(tick, Packet{Src: in, Dst: rng.Intn(4), Bytes: 64 * (1 + rng.Intn(10))})
				}
			}
		}
		// 每 tick 都校验一次守恒
		for i := 0; i < 100; i++ {
			sim.Run(1)
			if err := sw.CheckConservation(); err != nil {
				t.Fatalf("%v tick %d: %v", mode, sim.Now(), err)
			}
		}
	}
}

// 每 tick 每端口（入口与出口）至多发送一个包。
func TestAtMostOnePacketPerPortPerTick(t *testing.T) {
	for _, mode := range []Mode{ModeFIFO, ModeVOQ} {
		sw := New(Config{Ports: 4, Mode: mode, QueueCap: 256})
		inCnt := map[int]map[int]int{}  // tick -> input -> count
		outCnt := map[int]map[int]int{} // tick -> output -> count
		sw.OnDeliver = func(tick int, pkt Packet) {
			if inCnt[tick] == nil {
				inCnt[tick] = map[int]int{}
				outCnt[tick] = map[int]int{}
			}
			inCnt[tick][pkt.Src]++
			outCnt[tick][pkt.Dst]++
		}
		sim := NewSimulator(sw)
		rng := rand.New(rand.NewSource(99))
		for tick := 0; tick < 30; tick++ {
			for in := 0; in < 4; in++ {
				for k := 0; k < 2; k++ {
					sim.AddArrival(tick, Packet{Src: in, Dst: rng.Intn(4), Bytes: 64})
				}
			}
		}
		sim.Run(60)
		for tick, m := range inCnt {
			for in, c := range m {
				if c > 1 {
					t.Fatalf("%v tick %d: input %d sent %d packets in one tick", mode, tick, in, c)
				}
			}
			for out, c := range outCnt[tick] {
				if c > 1 {
					t.Fatalf("%v tick %d: output %d received %d packets in one tick", mode, tick, out, c)
				}
			}
		}
	}
}

// 相同流量下 VOQ 的吞吐不低于 FIFO，且在热点流量下严格更优。
func TestVOQOutperformsFIFOUnderHotspot(t *testing.T) {
	run := func(mode Mode) Stats {
		sw := New(Config{Ports: 4, Mode: mode, QueueCap: 64})
		sim := NewSimulator(sw)
		rng := rand.New(rand.NewSource(42))
		for tick := 0; tick < 500; tick++ {
			for in := 0; in < 4; in++ {
				if rng.Float64() < 0.7 {
					dst := 0
					if rng.Float64() >= 0.5 {
						dst = rng.Intn(4)
					}
					sim.AddArrival(tick, Packet{Src: in, Dst: dst, Bytes: 128})
				}
			}
		}
		sim.Run(500)
		return sw.Stats
	}
	fifo := run(ModeFIFO)
	voq := run(ModeVOQ)
	if voq.ReceivedBytes < fifo.ReceivedBytes {
		t.Fatalf("VOQ received bytes %d < FIFO %d", voq.ReceivedBytes, fifo.ReceivedBytes)
	}
	if voq.ReceivedBytes == fifo.ReceivedBytes {
		t.Fatalf("expected VOQ to strictly beat FIFO under hotspot, both=%d", voq.ReceivedBytes)
	}
	t.Logf("FIFO received=%dB avgLatency=%.1fT; VOQ received=%dB avgLatency=%.1fT",
		fifo.ReceivedBytes, fifo.AvgLatency(), voq.ReceivedBytes, voq.AvgLatency())
}
