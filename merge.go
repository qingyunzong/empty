package stats

import (
	"errors"
	"fmt"
	"sort"
)

// groupState 别名组的归并状态。
type groupState struct {
	members []string           // 归并时的成员用户（保持给定顺序）
	parked  map[string][]Event // 事件 ID -> 被去重/冲突隔离的副本（User 即来源）
}

// Merge 将若干用户归并为别名组。
//
// 成员事件并入组实体并按 (Time, ID) 重组顺序；同 ID 事件只保留成员列表中
// 最先出现的一份参与统计，其余副本（无论内容一致还是冲突）都被隔离到
// 隔离区（Quarantine 可查），拆分时按来源归还。归并后按任一成员别名查询
// 均得到组的统计快照。
//
// 返回状态发生变化的属主快照：组的新快照，以及各成员被清空后的零值快照。
func (s *Store) Merge(groupID string, members []string) ([]Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if groupID == "" {
		return nil, errors.New("stats: 别名组 ID 不能为空")
	}
	if len(members) == 0 {
		return nil, errors.New("stats: 归并成员不能为空")
	}
	if _, ok := s.entities[groupID]; ok {
		return nil, fmt.Errorf("stats: %q 已存在，不能作为别名组", groupID)
	}
	if _, ok := s.memberOf[groupID]; ok {
		return nil, fmt.Errorf("stats: %q 已是其他组的成员别名", groupID)
	}
	seen := map[string]bool{}
	for _, m := range members {
		if m == "" {
			return nil, errors.New("stats: 成员 ID 不能为空")
		}
		if m == groupID {
			return nil, fmt.Errorf("stats: 成员 %q 不能是别名组自身", m)
		}
		if seen[m] {
			return nil, fmt.Errorf("stats: 成员 %q 重复", m)
		}
		seen[m] = true
		if _, ok := s.memberOf[m]; ok {
			return nil, fmt.Errorf("stats: 用户 %q 已在别名组中", m)
		}
		if _, isGroup := s.groups[m]; isGroup {
			return nil, fmt.Errorf("stats: 别名组 %q 不能作为成员", m)
		}
	}

	affected := append([]string{groupID}, members...)
	pre := s.snapshotsOf(affected)

	gent := &entity{id: groupID, events: map[string]*Event{}}
	g := &groupState{members: append([]string(nil), members...), parked: map[string][]Event{}}
	for _, m := range members {
		ment := s.entities[m]
		if ment != nil {
			// 按 (Time, ID) 顺序并入，保证结果确定
			for _, ev := range ment.order {
				if _, dup := gent.events[ev.ID]; dup {
					// 同 ID 去重：冲突/重复副本隔离，不参与组统计
					g.parked[ev.ID] = append(g.parked[ev.ID], *ev)
				} else {
					cp := *ev
					gent.insert(&cp, s.n)
					s.addOwner(ev.ID, groupID)
				}
				s.removeOwner(ev.ID, m)
			}
			delete(s.entities, m)
		}
		s.memberOf[m] = groupID
	}
	s.entities[groupID] = gent
	s.groups[groupID] = g
	return s.emitChanged(affected, pre), nil
}

// Split 拆分别名组：组内规范事件按事件当前 User 归还来源用户，隔离区中
// 的副本也各自归还来源，组实体与别名关系随之删除。组存续期间输出的历史
// 快照保留在 History 中。
//
// 返回状态发生变化的属主快照：各成员恢复后的快照，以及组的零值快照。
func (s *Store) Split(groupID string) ([]Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.groups[groupID]
	if !ok {
		return nil, fmt.Errorf("stats: 别名组 %q 不存在", groupID)
	}
	gent := s.entities[groupID]
	affected := append([]string{groupID}, g.members...)
	pre := s.snapshotsOf(affected)

	// 先恢复隔离副本（按 ID 排序保证确定），再恢复规范副本。
	// 若归并期间的更正改写了事件所属用户，规范副本与隔离副本可能
	// 指向同一来源，此时以规范副本为准。
	ids := make([]string, 0, len(g.parked))
	for id := range g.parked {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		for _, ev := range g.parked[id] {
			ment := s.ensureEntity(ev.User)
			ment.remove(ev.ID, s.n)
			cp := ev
			ment.insert(&cp, s.n)
			s.addOwner(ev.ID, ev.User)
		}
	}
	// 规范副本回到各自来源（组内事件的 User 必为成员）
	for _, ev := range gent.order {
		ment := s.ensureEntity(ev.User)
		ment.remove(ev.ID, s.n)
		cp := *ev
		ment.insert(&cp, s.n)
		s.removeOwner(ev.ID, groupID)
		s.addOwner(ev.ID, ev.User)
	}
	delete(s.entities, groupID)
	delete(s.groups, groupID)
	for _, m := range g.members {
		delete(s.memberOf, m)
	}
	return s.emitChanged(affected, pre), nil
}
