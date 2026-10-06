package pcheck

import (
	"errors"
	"fmt"
)

// Replay 独立回放一条反例轨迹（证书）并验收：
// 逐步检查合法性（只能交付当前在途的消息、重复与崩溃预算各至多一次、
// 不能向已崩溃节点交付、不超出在途容量），并要求回放结束后
// 确实违反安全性质。全部满足返回 nil，否则返回拒绝原因。
func Replay(p *Protocol, trace []Step) error {
	if err := p.validate(); err != nil {
		return err
	}
	c := p.initial()
	for i, s := range trace {
		switch s.Kind {
		case StepDeliver:
			if s.Msg < 0 || s.Msg >= len(c.inFlight) {
				return fmt.Errorf("pcheck: 步骤 %d: 消息下标 %d 超出在途范围 %d", i, s.Msg, len(c.inFlight))
			}
			nc, ok := c.deliver(p, s.Msg, true)
			if !ok {
				return fmt.Errorf("pcheck: 步骤 %d: 无法交付消息 %d（接收方已崩溃、发送目标越界或超出容量）", i, s.Msg)
			}
			c = nc
		case StepDuplicate:
			if c.dupUsed {
				return fmt.Errorf("pcheck: 步骤 %d: 重复预算已用尽", i)
			}
			if s.Msg < 0 || s.Msg >= len(c.inFlight) {
				return fmt.Errorf("pcheck: 步骤 %d: 消息下标 %d 超出在途范围 %d", i, s.Msg, len(c.inFlight))
			}
			nc, ok := c.deliver(p, s.Msg, false)
			if !ok {
				return fmt.Errorf("pcheck: 步骤 %d: 无法重复交付消息 %d（接收方已崩溃、发送目标越界或超出容量）", i, s.Msg)
			}
			nc.dupUsed = true
			c = nc
		case StepCrash:
			if c.crashUsed {
				return fmt.Errorf("pcheck: 步骤 %d: 崩溃预算已用尽", i)
			}
			if s.Node < 0 || s.Node >= p.Nodes {
				return fmt.Errorf("pcheck: 步骤 %d: 节点 %d 越界", i, s.Node)
			}
			nc, ok := c.crash(s.Node)
			if !ok {
				return fmt.Errorf("pcheck: 步骤 %d: 节点 %d 已崩溃", i, s.Node)
			}
			c = nc
		default:
			return fmt.Errorf("pcheck: 步骤 %d: 未知步骤类型 %d", i, int(s.Kind))
		}
	}
	if p.Invariant(c.view()) {
		return errors.New("pcheck: 回放结束未违反安全性质，证书拒绝验收")
	}
	return nil
}
