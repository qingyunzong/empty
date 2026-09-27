package main

import "testing"

func packetByID(sim *Simulator, id int) *Packet {
	for _, p := range sim.Packets() {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func expectDelivered(t *testing.T, sim *Simulator, id int, at Tick) {
	t.Helper()
	p := packetByID(sim, id)
	if p.State != StateDelivered || p.DeliveredAt != at {
		t.Errorf("packet %d: want delivered@%d, got %s@%d", id, at, p.State, p.DeliveredAt)
	}
}

func expectDropped(t *testing.T, sim *Simulator, id int, at Tick) {
	t.Helper()
	p := packetByID(sim, id)
	if p.State != StateDropped || p.DroppedAt != at {
		t.Errorf("packet %d: want dropped@%d, got %s (dropped@%d)", id, at, p.State, p.DroppedAt)
	}
}

func TestNoFault(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 3, 1, 0)
	sim.Send(0, l, 1)
	sim.Send(0, l, 2)
	sim.Run()
	expectDelivered(t, sim, 1, 3) // t=0 发出
	expectDelivered(t, sim, 2, 4) // rate=1，t=1 发出
}

func TestPauseFreezesInTransitAndQueue(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 5, 1, 0)
	sim.Send(0, l, 1) // t=0 发出，原定于 t=5 送达
	sim.Send(0, l, 2) // t=1 发出，原定于 t=6 送达
	sim.Send(3, l, 3) // 故障期间到达，留在队列
	sim.Fault(2, l, PolicyPause)
	sim.Recover(4, l)
	sim.Run()
	expectDelivered(t, sim, 1, 7) // 剩余3，恢复后 4+3
	expectDelivered(t, sim, 2, 8) // 剩余4，恢复后 4+4
	expectDelivered(t, sim, 3, 9) // 恢复后队列继续，t=4 发出
}

func TestDropKillsInTransitAndNewSends(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 5, 2, 0)
	sim.Send(0, l, 1)
	sim.Send(0, l, 2)
	sim.Send(1, l, 3)
	sim.Fault(2, l, PolicyDrop)
	sim.Send(3, l, 4) // 故障期间发出，立即丢弃
	sim.Recover(4, l)
	sim.Send(5, l, 5)
	sim.Run()
	expectDropped(t, sim, 1, 2)
	expectDropped(t, sim, 2, 2)
	expectDropped(t, sim, 3, 2)
	expectDropped(t, sim, 4, 3)
	expectDelivered(t, sim, 5, 10)
}

func TestQueuedPacketSurvivesDropFault(t *testing.T) {
	// 在途包与未发包不同：drop 只杀在途包，队列中未发出的包
	// 若在故障期间未被发出，则恢复后正常送达。
	sim := NewSimulator()
	l := sim.AddLink("L", 2, 1, 0)
	sim.Send(0, l, 1)
	sim.Send(0, l, 2) // 排在队列里，故障期间未发出
	sim.Fault(0, l, PolicyDrop)
	sim.Recover(1, l)
	sim.Run()
	expectDropped(t, sim, 1, 0)   // 故障期间被发出 -> 丢弃
	expectDelivered(t, sim, 2, 3) // 恢复后 t=1 发出，t=3 送达
}

func TestDelayPostponesInTransit(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 3, 1, 2)
	sim.Send(0, l, 1) // t=0 发出，原定 t=3
	sim.Fault(1, l, PolicyDelay)
	sim.Send(2, l, 2) // 故障期间发出，携带额外延迟
	sim.Recover(4, l)
	sim.Send(5, l, 3)
	sim.Run()
	expectDelivered(t, sim, 1, 5) // 3+2
	expectDelivered(t, sim, 2, 7) // 2+3+2
	expectDelivered(t, sim, 3, 8) // 恢复后正常
}

func TestDuplicateFaultAndRecoverAreIdempotent(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 5, 1, 0)
	sim.Send(0, l, 1) // t=0 发出，原定 t=5
	sim.Fault(2, l, PolicyPause)
	sim.Fault(3, l, PolicyDrop) // 幂等忽略：策略固定为 pause，包不被丢弃
	sim.Recover(4, l)
	sim.Recover(5, l) // 幂等忽略
	sim.Run()
	expectDelivered(t, sim, 1, 7) // 与纯 pause 场景一致
}

func TestDroppedPacketsAreNotResurrected(t *testing.T) {
	sim := NewSimulator()
	l := sim.AddLink("L", 5, 1, 0)
	sim.Send(0, l, 1)
	sim.Fault(1, l, PolicyDrop)
	sim.Recover(3, l)
	sim.Recover(6, l) // 再次恢复也不能复活
	sim.Send(7, l, 2)
	sim.Run()
	expectDropped(t, sim, 1, 1)
	expectDelivered(t, sim, 2, 12)
}
