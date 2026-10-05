package numalloc

import "fmt"

// Transfer 把 from 租约的未消费尾部转让给 to。
//
// 顺序保证(先关闭旧代, 再授予新代):
//  1. fencing: 把 from 的持久化状态标记为 Closed, 旧代立即停发(含重启后);
//  2. 在分配器日志中关闭旧代, 固定已消费游标;
//  3. 以新代把尾部 [cursor, hi] 授予 to;
//  4. 把新租约写入 to 的持久化状态。
//
// 任意一步失败都可用相同 reqID 安全重试(各步幂等)。
func Transfer(from, to *Node, reqID string) error {
	if from.id == to.id {
		return fmt.Errorf("numalloc: cannot transfer a range to the same node")
	}

	// 1. fencing 旧代。
	fromMu := stateLock(from.path)
	fromMu.Lock()
	fst, err := from.loadLocked()
	if err != nil {
		fromMu.Unlock()
		return err
	}
	if !fst.HasLease {
		fromMu.Unlock()
		return ErrNoLease
	}
	if !fst.Closed {
		if fst.Cursor > fst.Hi {
			fromMu.Unlock()
			return fmt.Errorf("numalloc: nothing left to transfer")
		}
		fst.Closed = true
		if err := from.persistLocked(fst); err != nil {
			fromMu.Unlock()
			return err
		}
	}
	cursor, hi := fst.Cursor, fst.Hi
	fromMu.Unlock()

	// 2. 关闭旧代(幂等)。
	if _, err := from.alloc.CloseLease(from.id, cursor, reqID+":close"); err != nil {
		return err
	}

	// 3. 授予尾部给新代(幂等)。
	lease, err := from.alloc.GrantTransfer(to.id, from.id, cursor, hi, reqID+":grant")
	if err != nil {
		return err
	}

	// 4. 安装新租约到目标节点。
	toMu := stateLock(to.path)
	toMu.Lock()
	defer toMu.Unlock()
	tst, err := to.loadLocked()
	if err != nil {
		return err
	}
	if tst.Closed {
		return ErrClosed
	}
	if tst.HasLease && tst.Cursor <= tst.Hi && tst.Gen != lease.Gen {
		return fmt.Errorf("numalloc: target node %q already holds an active lease", to.id)
	}
	return to.persistLocked(NodeState{
		NodeID: to.id, HasLease: true,
		Gen: lease.Gen, Lo: lease.Lo, Hi: lease.Hi, Cursor: lease.Lo,
	})
}
