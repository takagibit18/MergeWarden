import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStructuralSignals as detect } from '../integrations/pi/src/structural-signals.ts';
import { frozenDiff } from '../src/snapshot/diff.ts';
const signals=(a,b,path='app.py')=>detect(path,frozenDiff(path,a,b));
for (const [name,a,b,type] of [
 ['parameter added','def foo(a):','def foo(a, b=False):','CALLER_CHECK'],
 ['parameter removed','def foo(a, b):','def foo(a):','CALLER_CHECK'],
 ['async signature','async def foo(a):','async def foo(a,b):','CALLER_CHECK'],
 ['removal','def foo(a):\n    pass','x = 1','CALLER_CHECK'],
 ['rename','def old_name(a):','def new_name(a):','CALLER_CHECK'],
 ['inheritance','class Child(BaseA):','class Child(BaseB):','INHERITANCE_CHECK'],
 ['exports',"__all__ = ['A']","__all__ = ['B']",'IMPORT_CHECK'],
]) test(`routing signal: ${name}`,()=>assert.equal(signals(a,b).find(s=>s.strength==='high')?.routeType,type));
test('init re-export',()=>assert.equal(signals('from .a import A','from .b import A','pkg/__init__.py')[0].routeType,'IMPORT_CHECK'));
test('multiline explicit exports',()=>assert.equal(signals('__all__ = [\n    "A",\n]\n','__all__ = [\n    "B",\n]\n')[0].routeType,'IMPORT_CHECK'));
for (const [name,a,b] of [
 ['arithmetic','    x = a + 1','    x = a + 2'],
 ['comment','# def foo(a):','# def foo(a,b):'],
 ['docstring','"""\ndef foo(a):\n"""','"""\ndef foo(a,b):\n"""'],
 ['format','def foo(a,b):','def foo( a, b ):'],
 ['local rename','    value = foo','    result = foo'],
 ['return scalar','    return 1','    return 2'],
 ['assertion','assert foo(1) == 1','assert foo(1) == 2'],
]) test(`no routing signal: ${name}`,()=>assert.equal(signals(a,b).filter(s=>s.strength==='high').length,0));
test('shape and annotation changes are weak only',()=>{
 assert.equal(signals('def foo(a) -> int:\n    return 1','def foo(a) -> list:\n    return [1]').length,2);
 assert.ok(signals('def foo(a) -> int:\n    return 1','def foo(a) -> list:\n    return [1]').every(s=>s.strength==='weak'));
});
