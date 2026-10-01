"""Dynamic partial-order reduction (DPOR) explorer.

Stateless DPOR in the style of Flanagan & Godefroid: backtrack sets are
kept per schedule prefix and updated along the current trace using the
happens-before relation.  Completed executions are fingerprinted by their
dependency-order (Mazurkiewicz) signature so that equivalent interleavings
are counted only once.
"""

from . import semantics as sem
from .model import dependent

OK = "OK"
VIOLATION = "VIOLATION"
E_LOCK = "E_LOCK"
BOUND_REACHED = "BOUND_REACHED"


def fingerprint(trace):
    """Mazurkiewicz signature of a trace: the set of dependency-ordered
    transition pairs.  Two traces are equivalent iff their signatures
    (and transition multisets) agree."""
    pairs = set()
    for a in range(len(trace)):
        ta = trace[a]
        for b in range(a + 1, len(trace)):
            tb = trace[b]
            if ta[0] != tb[0] and dependent(ta[2], tb[2]):
                pairs.add(((ta[0], ta[1]), (tb[0], tb[1])))
    return frozenset(pairs)


def _happens_before_ancestors(trace, k):
    """All indices i such that trace[i] happens-before trace[k]."""
    preds = [[] for _ in range(len(trace))]
    for j in range(len(trace)):
        for i in range(j):
            if trace[i][0] == trace[j][0] or dependent(trace[i][2], trace[j][2]):
                preds[j].append(i)
    ancestors = set()
    stack = [k]
    while stack:
        j = stack.pop()
        for i in preds[j]:
            if i not in ancestors:
                ancestors.add(i)
                stack.append(i)
    return ancestors


def _format_trace(trace):
    return [{"thread": tid, "pc": pc, "op": op} for tid, pc, op in trace]


class Explorer:
    def __init__(self, program, max_schedules=5000):
        self.program = program
        self.max_schedules = max_schedules
        self.backtrack = {}  # schedule prefix -> set of tids to explore
        self.done = {}       # schedule prefix -> set of tids already explored
        self.fingerprints = set()
        self.executions = 0
        self.status = OK
        self.witness = None
        self._elock_witness = None
        self._stop = False

    @property
    def schedules(self):
        """Number of distinct non-equivalent schedules explored."""
        return len(self.fingerprints)

    def run(self):
        self._explore(())
        if self.status != VIOLATION and self._elock_witness is not None:
            self.status = E_LOCK
            self.witness = self._elock_witness
        return self

    def report(self):
        return {
            "status": self.status,
            "schedules": self.schedules,
            "explored": self.executions,
            "witness": self.witness,
        }

    def _record_execution(self, trace):
        self.executions += 1
        self.fingerprints.add(fingerprint(trace))
        if self.schedules >= self.max_schedules:
            if self.status == OK:
                self.status = BOUND_REACHED
            self._stop = True

    def _explore(self, prefix):
        if self._stop:
            return
        state, trace = sem.replay(self.program, prefix)
        if state.error == sem.VIOLATION:
            self.status = VIOLATION
            self.witness = _format_trace(trace)
            self._stop = True
            return
        if state.error == sem.E_LOCK:
            if self._elock_witness is None:
                self._elock_witness = _format_trace(trace)
            self._record_execution(trace)
            return
        enabled = sem.enabled_threads(self.program, state)
        if not enabled:
            # All threads finished, or remaining threads are deadlocked.
            self._record_execution(trace)
            return
        bt = self.backtrack.setdefault(prefix, set())
        if not bt:
            bt.add(enabled[0])
        dn = self.done.setdefault(prefix, set())
        while not self._stop:
            remaining = (bt & set(enabled)) - dn
            if not remaining:
                break
            p = min(remaining)
            dn.add(p)
            self._update_backtracks(prefix, trace, state, p)
            self._explore(prefix + (p,))

    def _update_backtracks(self, prefix, trace, state, p):
        """For each earlier transition dependent with p's next transition,
        add a happens-before source set to the backtrack set of the
        corresponding prefix."""
        program = self.program
        t_op = program[p][state.pcs[p]]
        ext_trace = trace + [(p, state.pcs[p], t_op)]
        ancestors = _happens_before_ancestors(ext_trace, len(ext_trace) - 1)
        n = len(trace)
        for i in range(n):
            tid_i, _pc_i, op_i = trace[i]
            if tid_i == p or not dependent(op_i, t_op):
                continue
            pre = prefix[:i]
            pre_state, _ = sem.replay(program, pre)
            source = set()
            for q in sem.enabled_threads(program, pre_state):
                if q == p:
                    source.add(q)
                    continue
                q_op = program[q][pre_state.pcs[q]]
                if dependent(op_i, q_op):
                    source.add(q)
                    continue
                for j in range(i + 1, n):
                    if trace[j][0] == q and j in ancestors:
                        source.add(q)
                        break
            if source:
                self.backtrack.setdefault(pre, set()).update(source)


def explore_program(program, max_schedules=5000):
    """Run DPOR over a validated program and return the report dict."""
    return Explorer(program, max_schedules=max_schedules).run().report()
