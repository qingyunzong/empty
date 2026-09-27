// demo 在相同流量下对比 FIFO（队首阻塞）与 VOQ 两种模式的交换机表现。
package main

import (
	"fmt"
	"math/rand"

	"switchsim"
)

// genTraffic 生成确定性热点流量：每个入口每 tick 以概率 load 产生一个包，
// 目的出口以 hotspot 概率汇聚到 0 号出口，否则均匀随机。
func genTraffic(sim *switchsim.Simulator, rng *rand.Rand, ports, ticks int, load, hotspot float64) {
	for t := 0; t < ticks; t++ {
		for in := 0; in < ports; in++ {
			if rng.Float64() >= load {
				continue
			}
			dst := 0
			if rng.Float64() >= hotspot {
				dst = rng.Intn(ports)
			}
			sim.AddArrival(t, switchsim.Packet{
				Src:   in,
				Dst:   dst,
				Bytes: 64 + 64*rng.Intn(15), // 64~960 字节
			})
		}
	}
}

func run(mode switchsim.Mode, ports, ticks int, load, hotspot float64, seed int64) switchsim.Stats {
	sw := switchsim.New(switchsim.Config{Ports: ports, Mode: mode, QueueCap: 32})
	sim := switchsim.NewSimulator(sw)
	genTraffic(sim, rand.New(rand.NewSource(seed)), ports, ticks, load, hotspot)
	sim.Run(ticks)
	// 排空残留队列，便于统计收敛
	for sw.QueuedPkts() > 0 {
		sim.Run(1)
	}
	if err := sw.CheckConservation(); err != nil {
		panic(err)
	}
	return sw.Stats
}

func main() {
	const ports, ticks = 4, 2000
	const load, hotspot = 0.7, 0.5
	const seed = 42

	fmt.Printf("场景: %dx%d 交换机, %d tick, 每入口到达率 %.1f, 热点出口概率 %.1f\n\n",
		ports, ports, ticks, load, hotspot)
	fmt.Printf("%-10s %8s %8s %8s %10s %10s %10s %8s\n",
		"模式", "注入包", "收到包", "丢弃包", "注入字节", "收到字节", "丢弃字节", "平均时延")
	for _, mode := range []switchsim.Mode{switchsim.ModeFIFO, switchsim.ModeVOQ} {
		st := run(mode, ports, ticks, load, hotspot, seed)
		fmt.Printf("%-10s %8d %8d %8d %10d %10d %10d %7.2fT\n",
			mode.String(), st.Injected, st.Received, st.Dropped,
			st.InjectedBytes, st.ReceivedBytes, st.DroppedBytes, st.AvgLatency())
	}
	fmt.Println("\n守恒校验: 注入 = 收到 + 丢弃 + 队列残留（包数与字节数均通过）")
}
