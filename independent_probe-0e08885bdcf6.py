import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import zlib

locations = json.loads(pathlib.Path('evidence/source-locations.json').read_text())
python = '/home/delin/.local/bin/python3.11'
print('interpreter:', subprocess.check_output([python, '--version'], text=True).strip())

for side in ('A', 'B'):
    workspace = locations[side]['workspace']
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / 'nogoods.log'
        env = dict(os.environ, PYTHONPATH=workspace, PYTHONDONTWRITEBYTECODE='1')
        if side == 'A':
            valid = [["x", 1]]
        else:
            valid = [{"var": "x", "value": 1}]
        def entry(obj):
            payload = json.dumps(obj, separators=(',', ':')).encode()
            return struct.pack('>I', len(payload)) + payload + struct.pack('>I', zlib.crc32(payload))
        path.write_bytes(entry(valid) + entry({"bad": 1}) + entry(valid))
        result = subprocess.run([python, '-B', '-m', 'csp_persist', 'load', '--log', str(path)], env=env, text=True, capture_output=True)
        print(side, 'valid-CRC invalid-clause middle entry:', json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False))
        path.write_bytes(entry(valid) + entry('not a clause') + entry(valid))
        result = subprocess.run([python, '-B', '-m', 'csp_persist', 'load', '--log', str(path)], env=env, text=True, capture_output=True)
        print(side, 'valid-CRC wrong-type middle entry:', json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False))
        if side == 'B':
            code = "from csp_persist.solver import CSPSolver; s=CSPSolver({'x':[1,2]}); s.add_nogood([{'var':'x','value':1}]); print(s.solve(),s.pruned_nodes); print(s.solve(),s.pruned_nodes)"
            result = subprocess.run([python, '-B', '-c', code], env=env, text=True, capture_output=True)
            print(side, 'repeat solve counter:', json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False))
        else:
            code = "from csp_persist.solver import CSPSolver,NogoodStore; s=NogoodStore(); s.add([]); c=CSPSolver({},s); print(c.solve(),c.pruned)"
            result = subprocess.run([python, '-B', '-c', code], env=env, text=True, capture_output=True)
            print(side, 'empty nogood empty-domain solve:', json.dumps({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False))
