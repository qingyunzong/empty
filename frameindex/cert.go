package frameindex

import (
	"fmt"
	"sort"
	"strings"
)

// Certificate 是 seek 结果的拓扑证书：
// 给出闭包（去除环上帧）的一个可解码线性序，并附带可独立核验的证明。
type Certificate struct {
	Order []string // 解码顺序：严格按 DecodeTime 升序
}

// Certify 由 Plan 生成拓扑证书。
// 环上帧无法拓扑排序，被排除；若闭包含环，返回错误提示。
// 若某帧的参考在解码序中位于其后（依赖边与解码序矛盾），同样报错。
func (ix *Index) Certify(p *Plan) (*Certificate, error) {
	bad := p.onCycle()
	if len(p.Cycles) > 0 {
		var cs []string
		for _, c := range p.Cycles {
			cs = append(cs, c.String())
		}
		return nil, fmt.Errorf("frameindex: dependency cycle(s) present, no topological order: %s",
			strings.Join(cs, "; "))
	}

	members := make([]Frame, 0, len(p.Closure))
	for _, id := range p.Closure {
		if bad[id] {
			continue
		}
		f, ok := ix.Get(id)
		if !ok {
			return nil, fmt.Errorf("frameindex: closure frame %q not in index", id)
		}
		members = append(members, f)
	}
	// 解码序：仅按 DecodeTime（ID 兜底），绝不使用 DisplayTime。
	sort.Slice(members, func(i, j int) bool {
		if members[i].DecodeTime != members[j].DecodeTime {
			return members[i].DecodeTime < members[j].DecodeTime
		}
		return members[i].ID < members[j].ID
	})

	cert := &Certificate{Order: make([]string, len(members))}
	for i, f := range members {
		cert.Order[i] = f.ID
	}
	if err := ix.Verify(cert, p); err != nil {
		return nil, err
	}
	return cert, nil
}

// Verify 独立核验证书：对证书中每一帧，其在索引内且属于闭包的参考
// 必须已在证书中先于它出现。这模拟了解码器按证书顺序解码时的依赖检查。
func (ix *Index) Verify(cert *Certificate, p *Plan) error {
	pos := make(map[string]int, len(cert.Order))
	for i, id := range cert.Order {
		if _, dup := pos[id]; dup {
			return fmt.Errorf("frameindex: certificate contains duplicate frame %q", id)
		}
		pos[id] = i
	}
	inClosure := make(map[string]bool, len(p.Closure))
	for _, id := range p.Closure {
		inClosure[id] = true
	}
	for _, id := range cert.Order {
		if !inClosure[id] {
			return fmt.Errorf("frameindex: certificate frame %q not in closure", id)
		}
		f, ok := ix.Get(id)
		if !ok {
			return fmt.Errorf("frameindex: certificate frame %q not in index", id)
		}
		for _, ref := range f.Refs {
			if !inClosure[ref] {
				continue // 缺失参考或区间外参考（缺失参考已在 Plan.Missing 报告）
			}
			rp, ok := pos[ref]
			if !ok {
				return fmt.Errorf("frameindex: frame %q depends on %q which is absent from certificate", id, ref)
			}
			if rp >= pos[id] {
				return fmt.Errorf("frameindex: frame %q decoded before its reference %q", id, ref)
			}
		}
	}
	return nil
}
