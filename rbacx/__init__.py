"""rbacx: role-DAG permission engine with cyclic inheritance and epoch-ordered revocations."""

from .core import Policy, PolicyError, load_policy

__all__ = ["Policy", "PolicyError", "load_policy"]
__version__ = "0.1.0"
