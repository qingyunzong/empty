from gpupack.model import parse_instance
from gpupack.solver import schedule


def run(instance):
    """Solve a raw JSON-like instance and return the result payload."""
    gpus, jobs = parse_instance(instance)
    return schedule(gpus, jobs)


def by_id(result):
    return {j["id"]: j for j in result["jobs"]}
