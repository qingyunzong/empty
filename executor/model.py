"""Plan JSON parsing and validation."""

from __future__ import annotations

import json

from .engine import Action, OUTCOMES

MAX_BUDGET = 1000


class PlanError(Exception):
    """Raised for any invalid plan or CLI input. Maps to exit code 7."""


def _require(cond, message):
    if not cond:
        raise PlanError(message)


def _parse_action(node, seen_ids, path):
    _require(isinstance(node, dict), f"{path}: action must be an object")
    action_id = node.get("id")
    _require(isinstance(action_id, str) and action_id, f"{path}: 'id' must be a non-empty string")
    _require(action_id not in seen_ids, f"{path}: duplicate action id {action_id!r}")
    seen_ids.add(action_id)

    cost = node.get("cost", 0)
    comp_cost = node.get("compensation_cost", 0)
    _require(isinstance(cost, int) and not isinstance(cost, bool) and cost >= 0,
             f"{path}: 'cost' must be a non-negative integer")
    _require(isinstance(comp_cost, int) and not isinstance(comp_cost, bool) and comp_cost >= 0,
             f"{path}: 'compensation_cost' must be a non-negative integer")

    outcome = node.get("outcome", "success")
    _require(outcome in OUTCOMES, f"{path}: 'outcome' must be one of {OUTCOMES}")

    children_raw = node.get("children", [])
    _require(isinstance(children_raw, list), f"{path}: 'children' must be a list")
    children = [
        _parse_action(child, seen_ids, f"{path}/{action_id}")
        for child in children_raw
    ]
    return Action(
        id=action_id,
        cost=cost,
        compensation_cost=comp_cost,
        outcome=outcome,
        children=children,
    )


def parse_plan(text):
    """Parse plan JSON text into (root_action, budget). Raises PlanError."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PlanError(f"invalid JSON: {exc}") from exc
    _require(isinstance(data, dict), "plan must be a JSON object")
    budget = data.get("budget")
    _require(isinstance(budget, int) and not isinstance(budget, bool),
             "'budget' must be an integer")
    _require(0 <= budget <= MAX_BUDGET,
             f"'budget' must satisfy 0 <= B <= {MAX_BUDGET}")
    _require("root" in data, "plan must contain 'root'")
    root = _parse_action(data["root"], set(), "root")
    return root, budget


def load_plan_file(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise PlanError(f"cannot read plan file {path!r}: {exc}") from exc
    return parse_plan(text)
