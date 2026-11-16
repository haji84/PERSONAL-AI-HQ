"""Trusted host-only launcher. No model-output command execution; exec replaces us."""
import os
import resource
import sys

resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (360, 360))
resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
if len(sys.argv) < 2 or not os.path.isabs(sys.argv[1]):
    raise SystemExit('invalid trusted executable')
allowed = ('PATH', 'HOME', 'LD_LIBRARY_PATH', 'OMP_NUM_THREADS')
env = {key: os.environ[key] for key in allowed if key in os.environ}
os.execve(sys.argv[1], sys.argv[1:], env)
