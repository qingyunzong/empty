"""Dynamic partial-order reduction (DPOR) explorer.

Implements stateless DPOR in the style of Flanagan & Godefroid (POPL 2005)
combined with sleep sets (Godefroid, "Partial-Order Methods for the
Verification of Concurrent Systems"):

* The search is a depth-first traversal of the interleaving space with
  per-state backtrack/done sets.  After exploring a transition ``t``,
  every earlier transition of another thread that is *dependent* with
  ``t`` (same address with at least one write, or same lock) is a race
  and forces a backtrack point at the state preceding it.  If ``t``'s
  thread is not enabled there (e.g. blocked on a lock), all enabled
  threads are added conservatively.  Because lock/unlock transitions
  additionally change which threads are *enabled* (possibly indirectly,
  via chains of lock acquisitions), every lock/unlock transition also
  races with all other currently enabled threads.

* Each state also carries a sleep set: threads whose exploration from
  this state would only produce interleavings equivalent (in the
  Mazurkiewicz / happens-before sense) to ones already explored.  A
  slept thread is never selected, and sleep sets propagate downward
  across transitions that are independent of the slept ones.

Independent transitions never create backtrack points and are filtered
by sleep sets, so two interleavings that differ only by swapping
independent operations are explored exactly once, while every
happens-before equivalence class of the program is still covered.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .core import Program, State, dependent, enabled, step

MAX_REPORTED_ERRORS = 16


class _BoundReached(Exception):
    pass


class _ViolationFound(Exception):
    pass


@dataclass
class Result:
    status: str            # OK | VIOLATION | E_LOCK | BOUND_REACHED
    schedules: int         # number of terminated schedules explored
    explored: int          # number of states visited
    witness: list | None   # concrete schedule for VIOLATION / E_LOCK
    errors: list = field(default_factory=list)
    traces: list = field(default_factory=list)  # tid sequences, if collected

    def report(self) -> dict:
        return {
            "status": self.status,
            "schedules": self.schedules,
            "explored": self.explored,
            "witness": self.witness,
            "errors": self.errors,
        }


def explore(program: Program, max_schedules: int = 10000, collect_traces: bool = False) -> Result:
    if max_schedules < 1:
        raise ValueError("max_schedules must be >= 1")

    threads = program.threads
    names = [t.name for t in threads]

    states = [State.initial(program.num_threads)]  # states[i]: state before step i
    tids = []                        # tids[i]: thread executed at step i
    backtrack = [set()]
    done = [set()]

    schedules = 0
    explored = 0
    witness = None
    errors = []
    traces = []
    saw_e_lock = False

    def op_at(i):
        t = tids[i]
        return threads[t].ops[states[i].pcs[t]]

    def format_witness(extra=None):
        w = [{"thread": names[tids[i]], "op": op_at(i).raw} for i in range(len(tids))]
        if extra is not None:
            w.append(extra)
        return w

    def record_schedule(failed=None):
        nonlocal schedules
        schedules += 1
        if collect_traces:
            traces.append(list(tids) if failed is None else list(tids) + [failed])
        if schedules >= max_schedules:
            raise _BoundReached

    def recurse(sleep):
        nonlocal explored, witness, saw_e_lock, schedules
        explored += 1
        i = len(tids)
        state = states[i]
        en = enabled(program, state)
        if not en:
            # Terminal: all threads finished, or deadlocked on locks.
            record_schedule()
            return
        if not backtrack[i]:
            seeds = [t for t in en if t not in sleep]
            if not seeds:
                # Every enabled transition is slept: this state's
                # interleavings are equivalent to ones explored elsewhere.
                return
            backtrack[i].add(seeds[0])
        local_sleep = set(sleep)
        while True:
            remaining = sorted(backtrack[i] - done[i] - local_sleep)
            if not remaining:
                return
            p = remaining[0]
            done[i].add(p)
            op = threads[p].ops[state.pcs[p]]
            # Lock operations can disable (block) or enable other
            # threads' future transitions, possibly through chains of
            # enablement, so a purely dependency-based forward check is
            # unsound here.  Conservatively treat every other enabled
            # thread as racing with a lock/unlock transition; sleep sets
            # filter out the redundant interleavings this may create.
            # Data operations never affect enabledness, so their races
            # are all caught by the backward-looking detection below.
            if op.kind in ("lock", "unlock"):
                backtrack[i].update(q for q in en if q != p)
            new_state, event = step(program, state, p)
            if event == "E_LOCK":
                saw_e_lock = True
                bad = {"thread": names[p], "op": op.raw}
                if witness is None:
                    witness = format_witness(bad)
                if len(errors) < MAX_REPORTED_ERRORS:
                    errors.append({"type": "E_LOCK", "schedule": format_witness(bad)})
                record_schedule(failed=p)
                # The error truncated this schedule, so races between
                # already-executed transitions and transitions that would
                # only execute later can never be observed.  Conservatively
                # add every enabled thread at every state along the current
                # trace to keep the exploration sound; sleep sets still
                # filter out equivalent interleavings.
                for j in range(i + 1):
                    backtrack[j].update(enabled(program, states[j]))
                continue
            if event == "ASSERT":
                schedules += 1
                if collect_traces:
                    traces.append(list(tids) + [p])
                witness = format_witness({"thread": names[p], "op": op.raw})
                raise _ViolationFound
            # Sleep set of the child state: slept threads whose next
            # transition is independent of the one just taken.
            child_sleep = set()
            for q in local_sleep:
                if q != p and q in en:
                    q_op = threads[q].ops[state.pcs[q]]
                    if not dependent(op, q_op):
                        child_sleep.add(q)
            tids.append(p)
            states.append(new_state)
            backtrack.append(set())
            done.append(set())
            recurse(child_sleep)
            tids.pop()
            states.pop()
            backtrack.pop()
            done.pop()
            local_sleep.add(p)
            # Race detection: every earlier transition of another thread
            # that is dependent with t = (p, op) needs a backtrack point.
            for j in range(i - 1, -1, -1):
                if tids[j] != p and dependent(op_at(j), op):
                    enj = enabled(program, states[j])
                    if p in enj:
                        backtrack[j].add(p)
                    else:
                        backtrack[j].update(enj)

    try:
        recurse(frozenset())
    except _ViolationFound:
        return Result("VIOLATION", schedules, explored, witness, errors, traces)
    except _BoundReached:
        pass

    if saw_e_lock:
        status = "E_LOCK"
    elif schedules >= max_schedules:
        status = "BOUND_REACHED"
    else:
        status = "OK"
    return Result(status, schedules, explored, witness, errors, traces)
