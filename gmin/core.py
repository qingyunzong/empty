"""Core line/character based test-case minimization.

The reducer works on decoded ``str`` (never on raw bytes) so every
transformation keeps the candidate valid UTF-8 once encoded.

Transformation priority (highest first):
  1. delete contiguous line blocks
  2. delete single lines
  3. delete contiguous character blocks inside a line
  4. replace characters with entries from a replacement table
     (only with strictly "simpler" entries, i.e. earlier in the table,
     so replacements always make progress and cannot cycle)

Termination requires a verification pass proving that no single-line
deletion and no single-character deletion triggers the oracle anymore.
All oracle invocations (including verification) count against the budget.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import Optional, Sequence

TRIGGER_EXIT_CODE = 42
DEFAULT_TIMEOUT = 1.0
DEFAULT_REPLACEMENTS: tuple[str, ...] = ("a", "0", " ", "_")

STATUS_OK = "OK"
STATUS_BUDGET_EXCEEDED = "BUDGET_EXCEEDED"


class BudgetExceeded(Exception):
    """Raised when the oracle check budget is exhausted."""


@dataclass
class Oracle:
    """Runs an oracle script; exit code 42 means the defect is triggered.

    A timeout or any non-42 exit code counts as "not triggered".
    """

    path: str
    budget: int
    timeout: float = DEFAULT_TIMEOUT
    checks: int = 0

    def triggers(self, text: str) -> bool:
        if self.checks >= self.budget:
            raise BudgetExceeded()
        self.checks += 1
        try:
            proc = subprocess.run(
                [sys.executable, self.path],
                input=text.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return False
        except OSError:
            return False
        return proc.returncode == TRIGGER_EXIT_CODE


@dataclass
class ReductionResult:
    text: str
    status: str
    checks: int

    @property
    def byte_count(self) -> int:
        return len(self.text.encode("utf-8"))


def reduce_text(
    text: str,
    oracle: Oracle,
    replacements: Sequence[str] = DEFAULT_REPLACEMENTS,
) -> ReductionResult:
    """Reduce ``text`` while ``oracle`` keeps reporting the defect."""
    initial = text.split("\n")
    state = {"lines": initial, "seen": {_join(initial)}}
    try:
        _run(state, oracle, tuple(replacements))
        status = STATUS_OK
    except BudgetExceeded:
        status = STATUS_BUDGET_EXCEEDED
    return ReductionResult("\n".join(state["lines"]), status, oracle.checks)


def _run(state: dict, oracle: Oracle, replacements: tuple[str, ...]) -> None:
    while True:
        while _improve_once(state, oracle, replacements):
            pass
        if not _verify(state, oracle):
            return


def _improve_once(state: dict, oracle: Oracle, replacements: tuple[str, ...]) -> bool:
    for phase in (
        _line_block_deletion,
        _single_line_deletion,
        _char_block_deletion,
        _char_replacement,
    ):
        new_lines = phase(state, oracle, replacements)
        if new_lines is not None:
            state["lines"] = new_lines
            return True
    return False


def _accept(state: dict, candidate: list[str], oracle: Oracle) -> bool:
    """A candidate is only eligible if it triggers and was never visited.

    The seen-set prevents replacement cycles (replacements do not shrink
    the candidate, so two states could otherwise ping-pong forever).
    """
    text = _join(candidate)
    if text in state["seen"]:
        return False
    if not oracle.triggers(text):
        return False
    state["seen"].add(text)
    return True


def _join(lines: list[str]) -> str:
    return "\n".join(lines)


def _line_block_deletion(
    state: dict, oracle: Oracle, _: tuple[str, ...]
) -> Optional[list[str]]:
    lines = state["lines"]
    n = len(lines)
    size = n // 2
    while size >= 2:
        start = 0
        while start + size <= n:
            candidate = lines[:start] + lines[start + size :]
            if _accept(state, candidate, oracle):
                return candidate
            start += 1
        size //= 2
    return None


def _single_line_deletion(
    state: dict, oracle: Oracle, _: tuple[str, ...]
) -> Optional[list[str]]:
    lines = state["lines"]
    for i in range(len(lines)):
        candidate = lines[:i] + lines[i + 1 :]
        if _accept(state, candidate, oracle):
            return candidate
    return None


def _char_block_deletion(
    state: dict, oracle: Oracle, _: tuple[str, ...]
) -> Optional[list[str]]:
    lines = state["lines"]
    for idx, line in enumerate(lines):
        n = len(line)
        size = n // 2
        while size >= 1:
            start = 0
            while start + size <= n:
                new_line = line[:start] + line[start + size :]
                candidate = lines[:idx] + [new_line] + lines[idx + 1 :]
                if _accept(state, candidate, oracle):
                    return candidate
                start += 1
            size //= 2
    return None


def _char_replacement(
    state: dict, oracle: Oracle, replacements: tuple[str, ...]
) -> Optional[list[str]]:
    lines = state["lines"]
    for idx, line in enumerate(lines):
        for pos, ch in enumerate(line):
            for repl in replacements:
                if not _is_simpler(repl, ch, replacements):
                    continue
                new_line = line[:pos] + repl + line[pos + 1 :]
                candidate = lines[:idx] + [new_line] + lines[idx + 1 :]
                if _accept(state, candidate, oracle):
                    return candidate
    return None


def _is_simpler(repl: str, ch: str, replacements: tuple[str, ...]) -> bool:
    """``repl`` must rank strictly earlier in the table than ``ch``.

    Characters outside the table rank just past its end, so any table
    entry simplifies them, and table entries never replace each other
    laterally (which would only explore equivalent states).
    """
    try:
        repl_rank = replacements.index(repl)
    except ValueError:
        return False
    try:
        ch_rank = replacements.index(ch)
    except ValueError:
        ch_rank = len(replacements)
    return repl_rank < ch_rank


def _verify(state: dict, oracle: Oracle) -> bool:
    """Check 1-minimality. Returns True if an improvement was found."""
    lines = state["lines"]
    for i in range(len(lines)):
        candidate = lines[:i] + lines[i + 1 :]
        if _accept(state, candidate, oracle):
            state["lines"] = candidate
            return True
    for idx, line in enumerate(lines):
        for pos in range(len(line)):
            new_line = line[:pos] + line[pos + 1 :]
            candidate = lines[:idx] + [new_line] + lines[idx + 1 :]
            if _accept(state, candidate, oracle):
                state["lines"] = candidate
                return True
    return False
