"""1-UIP conflict explanation for backtracking search with implication logs."""

from .model import Conflict, Decision, Implication, Literal, Model, ValidationError, parse_model
from .uip import AnalysisError, ClauseLiteral, Explanation, generate_explanation

__all__ = [
    "AnalysisError",
    "ClauseLiteral",
    "Conflict",
    "Decision",
    "Explanation",
    "Implication",
    "Literal",
    "Model",
    "ValidationError",
    "generate_explanation",
    "parse_model",
]

__version__ = "1.0.0"
