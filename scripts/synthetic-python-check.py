"""Trusted narrow arithmetic checker, not an arbitrary-program sandbox."""
import ast
import hashlib
import json
import resource
import sys

resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
CASES = ((2, 3, 5), (-4, 3, -1), (0, 0, 0), (3, 2, 5), (-3, -2, -5), (9, 0, 9))

def reject():
    raise ValueError('source outside arithmetic whitelist')

def expression(node, depth=0):
    if depth > 12:
        reject()
    if type(node) is ast.Name and node.id in ('a', 'b') and type(node.ctx) is ast.Load:
        return
    if type(node) is ast.Constant and type(node.value) is int and abs(node.value) <= 1000:
        return
    if type(node) is ast.BinOp and type(node.op) in (ast.Add, ast.Sub, ast.Mult):
        expression(node.left, depth + 1)
        expression(node.right, depth + 1)
        return
    reject()

def check(source):
    if not isinstance(source, str) or len(source.encode()) > 20000:
        reject()
    tree = ast.parse(source)
    if len(list(ast.walk(tree))) > 64 or len(tree.body) != 1:
        reject()
    f = tree.body[0]
    if type(f) is not ast.FunctionDef or f.name != 'add' or f.decorator_list or f.returns or f.type_comment or getattr(f, 'type_params', []) or len(f.body) != 1 or type(f.body[0]) is not ast.Return:
        reject()
    a = f.args
    if a.posonlyargs or a.kwonlyargs or a.vararg or a.kwarg or a.defaults or a.kw_defaults or [x.arg for x in a.args] != ['a', 'b'] or any(x.annotation or x.type_comment for x in a.args):
        reject()
    expression(f.body[0].value)
    identity = {'canonicalSource': ast.unparse(tree), 'semanticSha256': hashlib.sha256(ast.dump(tree, include_attributes=False).encode()).hexdigest()}
    namespace = {'__builtins__': {}}
    exec(compile(tree, '<validated-synthetic>', 'exec'), namespace)
    for x, y, expected in CASES:
        actual = namespace['add'](x, y)
        if type(actual) is not int or actual != expected:
            return {**identity, 'status': 'ASSERTION_FAILURE', 'failure': f'add({x}, {y}): expected {expected}, got {actual}'}
    return {**identity, 'status': 'PASS', 'caseCount': len(CASES)}

try:
    data = sys.stdin.buffer.read(21001)
    if len(data) > 21000:
        reject()
    result = check(json.loads(data)['source'])
except (ValueError, SyntaxError, TypeError, KeyError, RecursionError):
    result = {'status': 'SAFETY_REJECTED'}
result['testsSha256'] = hashlib.sha256(json.dumps(CASES).encode()).hexdigest()
result['pythonVersion'] = sys.version.split()[0]
print(json.dumps(result))
