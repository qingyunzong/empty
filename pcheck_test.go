package pcheck

import (
	"fmt"
	"strings"
	"testing"
)

// counterProtocol 构造单节点计数器协议：状态 "0"->"1"->"2"，
// 种子消息 inc 指向自身。不重复时最多到达 "1"；重复一次可到达 "2"。
func counterProtocol() *Protocol {
	return &Protocol{
		Nodes:   1,
		Initial: []string{"0"},
		Tables: []Table{{
			"0": {"inc": {Next: "1"}},
			"1": {"inc": {Next: "2"}},
			"2": {"inc": {Next: "2"}},
		}},
		Seed: []Message{{From: 0, To: 0, Kind: "inc"}},
		Invariant: func(cfg ConfigView) bool {
			return cfg.States[0] != "2"
		},
	}
}

// 重复一次导致反例，且 BFS 报告最短轨迹 [duplicate, deliver]。
func TestDuplicateShortestCounterexample(t *testing.T) {
	p := counterProtocol()
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unsafe {
		t.Fatalf("结论 = %v，期望 Unsafe", res.Verdict)
	}
	if len(res.Trace) != 2 {
		t.Fatalf("反例长度 = %d，期望最短为 2: %v", len(res.Trace), res.Trace)
	}
	if res.Trace[0].Kind != StepDuplicate || res.Trace[1].Kind != StepDeliver {
		t.Fatalf("反例轨迹 = %v，期望 [duplicate deliver]", res.Trace)
	}
	if err := Replay(p, res.Trace); err != nil {
		t.Fatalf("证书回放验收失败: %v", err)
	}
}

// 重排敏感：只有先 a 后 b 才违规。
func reorderProtocol() *Protocol {
	return &Protocol{
		Nodes:   1,
		Initial: []string{"s0"},
		Tables: []Table{{
			"s0":  {"a": {Next: "sa"}, "b": {Next: "sb"}},
			"sa":  {"a": {Next: "sa"}, "b": {Next: "bad"}},
			"sb":  {"a": {Next: "sb"}, "b": {Next: "sb"}},
			"bad": {"a": {Next: "bad"}, "b": {Next: "bad"}},
		}},
		Seed: []Message{{From: 0, To: 0, Kind: "a"}, {From: 0, To: 0, Kind: "b"}},
		Invariant: func(cfg ConfigView) bool {
			return cfg.States[0] != "bad"
		},
	}
}

func TestReorderCounterexample(t *testing.T) {
	p := reorderProtocol()
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unsafe || len(res.Trace) != 2 {
		t.Fatalf("结论 = %v，轨迹 = %v，期望 2 步最短反例", res.Verdict, res.Trace)
	}
	if err := Replay(p, res.Trace); err != nil {
		t.Fatalf("证书回放验收失败: %v", err)
	}
	// 相反的交付顺序（先 b 后 a）不违规，证书必须被拒绝。
	bFirst := []Step{
		{Kind: StepDeliver, Msg: 1},
		{Kind: StepDeliver, Msg: 0},
	}
	if err := Replay(p, bFirst); err == nil {
		t.Fatal("先 b 后 a 的证书未违规，应被拒绝")
	}
}

// 崩溃语义：主备协议中，备份在主节点存活时不得成为 leader。
func failoverProtocol() *Protocol {
	return &Protocol{
		Nodes:   2,
		Initial: []string{"leader", "follower"},
		Tables: []Table{
			nil, // 主节点丢弃所有消息
			{
				"follower": {
					"ping":  {Next: "follower", Sends: []Message{{To: 1, Kind: "elect"}}},
					"elect": {Next: "leader"},
				},
				"leader": {},
			},
		},
		Seed: []Message{{From: 0, To: 1, Kind: "ping"}},
		Invariant: func(cfg ConfigView) bool {
			primaryLeader := cfg.Alive[0] && cfg.States[0] == "leader"
			backupLeader := cfg.Alive[1] && cfg.States[1] == "leader"
			return !(primaryLeader && backupLeader)
		},
	}
}

func TestCrashFaultEnumerated(t *testing.T) {
	p := failoverProtocol()
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	// 最短反例：交付 ping 再交付 elect，两步出现双 leader。
	if res.Verdict != Unsafe || len(res.Trace) != 2 {
		t.Fatalf("结论 = %v，轨迹 = %v，期望 2 步最短反例", res.Verdict, res.Trace)
	}
	if err := Replay(p, res.Trace); err != nil {
		t.Fatalf("证书回放验收失败: %v", err)
	}
	// 主节点先崩溃则同样的交付序列不违规，证书必须被拒绝。
	safeTrace := []Step{
		{Kind: StepCrash, Node: 0},
		{Kind: StepDeliver, Msg: 0},
		{Kind: StepDeliver, Msg: 0},
	}
	if err := Replay(p, safeTrace); err == nil {
		t.Fatal("主节点已崩溃的执行不违规，证书应被拒绝")
	}
}

// 闭合无反例：ping-pong 协议状态空间有限，应得出 Safe 而非 Unknown。
func pingPongProtocol() *Protocol {
	return &Protocol{
		Nodes:   2,
		Initial: []string{"idle", "idle"},
		Tables: []Table{
			{"idle": {"pong": {Next: "idle", Sends: []Message{{To: 1, Kind: "ping"}}}}},
			{"idle": {"ping": {Next: "idle", Sends: []Message{{To: 0, Kind: "pong"}}}}},
		},
		Seed: []Message{{From: 0, To: 1, Kind: "ping"}},
		Invariant: func(cfg ConfigView) bool {
			return true
		},
	}
}

func TestSafeClosedStateSpace(t *testing.T) {
	res, err := Check(pingPongProtocol(), Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Safe {
		t.Fatalf("结论 = %v，期望 Safe（闭合）", res.Verdict)
	}
	if res.Explored == 0 || res.Explored > 100 {
		t.Fatalf("探索配置数 = %d，期望为有限小值", res.Explored)
	}
}

// 无限计数器协议：状态空间不闭合，用于预算测试。
func unboundedProtocol() *Protocol {
	const n = 4096
	tab := Table{}
	for i := 0; i < n; i++ {
		cur := fmt.Sprintf("n%d", i)
		tab[cur] = map[string]Transition{
			"inc": {Next: fmt.Sprintf("n%d", i+1), Sends: []Message{{To: 0, Kind: "inc"}}},
		}
	}
	return &Protocol{
		Nodes:   1,
		Initial: []string{"n0"},
		Tables:  []Table{tab},
		Seed:    []Message{{From: 0, To: 0, Kind: "inc"}},
		Invariant: func(cfg ConfigView) bool {
			return true
		},
	}
}

func TestStateBudgetExhaustedUnknown(t *testing.T) {
	res, err := Check(unboundedProtocol(), Budget{MaxStates: 200})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unknown {
		t.Fatalf("结论 = %v，期望 Unknown（预算未闭合）", res.Verdict)
	}
	if res.Explored > 200 {
		t.Fatalf("探索配置数 = %d，超出预算 200", res.Explored)
	}
}

func TestDepthBudgetExhaustedUnknown(t *testing.T) {
	res, err := Check(unboundedProtocol(), Budget{MaxDepth: 5})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unknown {
		t.Fatalf("结论 = %v，期望 Unknown（深度预算未闭合）", res.Verdict)
	}
	if res.Depth > 5 {
		t.Fatalf("到达深度 = %d，超出预算 5", res.Depth)
	}
}

// 种子消息至多 12 条。
func TestSeedMessageLimit(t *testing.T) {
	mk := func(n int) *Protocol {
		seed := make([]Message, n)
		for i := range seed {
			seed[i] = Message{From: 0, To: 0, Kind: "m"}
		}
		return &Protocol{
			Nodes:   1,
			Initial: []string{"s"},
			Tables:  []Table{{"s": {}}},
			Seed:    seed,
			Invariant: func(cfg ConfigView) bool {
				return true
			},
		}
	}
	if _, err := Check(mk(MaxSeedMessages), Budget{}); err != nil {
		t.Fatalf("%d 条种子消息应被接受: %v", MaxSeedMessages, err)
	}
	if _, err := Check(mk(MaxSeedMessages+1), Budget{}); err == nil {
		t.Fatalf("%d 条种子消息应被拒绝", MaxSeedMessages+1)
	}
}

// 在途容量：一次迁移发出 13 条消息超过默认容量 12，该后继被跳过。
func TestInFlightCapacity(t *testing.T) {
	sends := make([]Message, DefaultMaxInFlight+1)
	for i := range sends {
		sends[i] = Message{To: 0, Kind: "go"}
	}
	p := &Protocol{
		Nodes:   1,
		Initial: []string{"s"},
		Tables:  []Table{{"s": {"go": {Next: "s", Sends: sends}}}},
		Seed:    []Message{{From: 0, To: 0, Kind: "go"}},
		Invariant: func(cfg ConfigView) bool {
			return len(cfg.InFlight) <= DefaultMaxInFlight
		},
	}
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Safe {
		t.Fatalf("结论 = %v，期望 Safe（超容量后继被跳过）", res.Verdict)
	}
}

// 证书验收：各类非法证书必须被拒绝。
func TestReplayRejectsInvalidCertificates(t *testing.T) {
	p := counterProtocol()
	cases := []struct {
		name  string
		trace []Step
		want  string
	}{
		{"下标越界", []Step{{Kind: StepDeliver, Msg: 5}}, "超出在途范围"},
		{"重复预算用尽", []Step{
			{Kind: StepDuplicate, Msg: 0},
			{Kind: StepDuplicate, Msg: 0},
		}, "重复预算已用尽"},
		{"崩溃预算用尽", []Step{
			{Kind: StepCrash, Node: 0},
			{Kind: StepCrash, Node: 0},
		}, "崩溃预算已用尽"},
		{"向已崩溃节点交付", []Step{
			{Kind: StepCrash, Node: 0},
			{Kind: StepDeliver, Msg: 0},
		}, "无法交付"},
		{"未违反安全性质", []Step{{Kind: StepDeliver, Msg: 0}}, "未违反安全性质"},
		{"未知步骤类型", []Step{{Kind: StepKind(99)}}, "未知步骤类型"},
	}
	for _, tc := range cases {
		err := Replay(p, tc.trace)
		if err == nil {
			t.Errorf("%s: 证书应被拒绝", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: 错误 %q 不含 %q", tc.name, err.Error(), tc.want)
		}
	}
}

// 初始配置即违规：空轨迹即为有效证书。
func TestInitialViolationEmptyCertificate(t *testing.T) {
	p := counterProtocol()
	p.Invariant = func(cfg ConfigView) bool { return cfg.States[0] != "0" }
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unsafe || len(res.Trace) != 0 {
		t.Fatalf("结论 = %v，轨迹 = %v，期望 0 步反例", res.Verdict, res.Trace)
	}
	if err := Replay(p, res.Trace); err != nil {
		t.Fatalf("空证书回放验收失败: %v", err)
	}
}

// 一步即可违规时，BFS 不得返回更长的轨迹。
func TestShortestTraceLengthOne(t *testing.T) {
	p := &Protocol{
		Nodes:   1,
		Initial: []string{"s0"},
		Tables:  []Table{{"s0": {"x": {Next: "bad"}}}},
		Seed:    []Message{{From: 0, To: 0, Kind: "x"}},
		Invariant: func(cfg ConfigView) bool {
			return cfg.States[0] != "bad"
		},
	}
	res, err := Check(p, Budget{})
	if err != nil {
		t.Fatalf("Check 出错: %v", err)
	}
	if res.Verdict != Unsafe || len(res.Trace) != 1 {
		t.Fatalf("结论 = %v，轨迹 = %v，期望 1 步最短反例", res.Verdict, res.Trace)
	}
}

// 协议定义校验。
func TestProtocolValidation(t *testing.T) {
	base := counterProtocol()
	bad := *base
	bad.Nodes = 0
	if _, err := Check(&bad, Budget{}); err == nil {
		t.Error("Nodes 为 0 应报错")
	}
	bad = *base
	bad.Initial = nil
	if _, err := Check(&bad, Budget{}); err == nil {
		t.Error("Initial 长度不符应报错")
	}
	bad = *base
	bad.Invariant = nil
	if _, err := Check(&bad, Budget{}); err == nil {
		t.Error("缺少 Invariant 应报错")
	}
	bad = *base
	bad.Seed = []Message{{From: 0, To: 7, Kind: "x"}}
	if _, err := Check(&bad, Budget{}); err == nil {
		t.Error("种子消息端点越界应报错")
	}
}

func ExampleCheck() {
	res, _ := Check(pingPongProtocol(), Budget{})
	fmt.Println(res.Verdict)
	// Output: Safe
}
