package main

import "fmt"

// 演示场景：一条链路依次经历 pause / delay / drop 三种故障，
// 其中穿插重复的故障与恢复事件（应被幂等忽略）。
func main() {
	sim := NewSimulator()
	link := sim.AddLink("L1", 3, 1, 2) // 时延3，每tick发1包，delay策略加2

	sim.Send(0, link, 1)
	sim.Send(0, link, 2)
	sim.Send(0, link, 3)
	sim.Send(0, link, 4)
	sim.Send(2, link, 5)
	sim.Send(6, link, 6)
	sim.Send(9, link, 7)
	sim.Send(13, link, 8)

	sim.Fault(1, link, PolicyPause) // t=1 暂停故障
	sim.Fault(2, link, PolicyDrop)  // 重复故障：幂等忽略，策略仍为 pause
	sim.Recover(4, link)            // t=4 恢复，队列继续
	sim.Fault(6, link, PolicyDelay) // t=6 延迟故障
	sim.Recover(8, link)            // t=8 恢复
	sim.Fault(10, link, PolicyDrop) // t=10 丢弃故障
	sim.Recover(12, link)           // t=12 恢复，已丢弃包不复活
	sim.Recover(13, link)           // 重复恢复：幂等忽略

	sim.Run()

	fmt.Println("link L1: latency=3 rate=1/tick delay=+2")
	fmt.Println("faults: pause@1..4 (dup drop@2 ignored), delay@6..8, drop@10..12 (dup recover@13 ignored)")
	fmt.Println()
	fmt.Printf("%-7s %-10s %s\n", "packet", "state", "at_tick")
	for _, p := range sim.Packets() {
		switch p.State {
		case StateDelivered:
			fmt.Printf("%-7d %-10s %d\n", p.ID, p.State, p.DeliveredAt)
		case StateDropped:
			fmt.Printf("%-7d %-10s %d\n", p.ID, p.State, p.DroppedAt)
		default:
			fmt.Printf("%-7d %-10s %s\n", p.ID, p.State, "-")
		}
	}
}
