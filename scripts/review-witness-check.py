"""Trusted arithmetic interpretation only. Never eval/exec reviewer output."""
import ast
import hashlib
import json
import resource
import sys

resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024**2,) * 2)
CASES = ((2, 3, 5), (-4, 3, -1), (0, 0, 0), (3, 2, 5), (-3, -2, -5), (9, 0, 9))

def reject():
    raise ValueError('invalid trusted arithmetic input')

def expression(node, values, depth=0):
    if depth > 12:
        reject()
    if type(node) is ast.Name and node.id in ('a', 'b') and type(node.ctx) is ast.Load:
        return values[node.id]
    if type(node) is ast.Constant and type(node.value) is int and abs(node.value) <= 1000:
        return node.value
    if type(node) is ast.BinOp and type(node.op) in (ast.Add, ast.Sub, ast.Mult):
        left = expression(node.left, values, depth + 1)
        right = expression(node.right, values, depth + 1)
        if type(node.op) is ast.Add:
            return left + right
        if type(node.op) is ast.Sub:
            return left - right
        return left * right
    reject()

def check(data):
    source = data['source']
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
    outcomes = [expression(f.body[0].value, {'a': x, 'b': y}) == expected for x, y, expected in CASES]
    result = {'testStatus': 'PASS' if all(outcomes) else 'ASSERTION_FAILURE', 'caseCount': len(CASES), 'testsSha256': hashlib.sha256(json.dumps(CASES).encode()).hexdigest(), 'canonicalSource': ast.unparse(tree), 'astSha256': hashlib.sha256(ast.dump(tree, include_attributes=False).encode()).hexdigest()}
    example = data.get('example')
    if example is not None:
        if not isinstance(example, dict) or set(example) != {'a', 'b', 'actual', 'required'}:
            reject()
        for key, value in example.items():
            if type(value) is not int or abs(value) > (9 if key in ('a', 'b') else 18):
                reject()
        actual = expression(f.body[0].value, {'a': example['a'], 'b': example['b']})
        required = example['a'] + example['b']
        result.update(actual=actual, required=required, witnessValid=actual == example['actual'] and required == example['required'], mismatch=actual != required)
    return result

try:
    raw = sys.stdin.buffer.read(22001)
    if len(raw) > 22000:
        reject()
    result = check(json.loads(raw))
    print(json.dumps(result))
except (ValueError, TypeError, KeyError, SyntaxError, RecursionError):
    print('invalid trusted arithmetic input', file=sys.stderr)
    raise SystemExit(2)
