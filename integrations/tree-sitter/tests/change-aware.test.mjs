import test from 'node:test';
import assert from 'node:assert/strict';
import {PythonTreeSitterExtractor} from '../src/python-extractor.ts';
import {matchDeclarations,declarationSignals} from '../../../src/engine/declarations.ts';
const parser=await PythonTreeSitterExtractor.create();
const changes=(a,b)=>{const x=parser.declarations('app.py',a),y=parser.declarations('app.py',b);return matchDeclarations(x.declarations,y.declarations,'s',x.parseComplete&&y.parseComplete);};
test.after(()=>parser.dispose());
test('getter setter role and lexical scope survive reordered declarations and line relocation',()=>{
 const a='class A:\n @property\n def values(self): return 1\n @values.setter\n def values(self, values): pass\nclass B:\n def values(self, x): pass\n';
 const b='\nclass A:\n @values.setter\n def values(self, values): pass\n @property\n def values(self): return 2\nclass B:\n def values(self, x, y): pass\n';
 const units=changes(a,b),signals=declarationSignals(units);
 assert.equal(signals.filter(s=>s.reason==='signature_changed').length,1);
 assert.equal(signals.find(s=>s.reason==='signature_changed').change.head.scope,'B');
 assert.ok(units.every(c=>!c.base||!c.head||c.base.role===c.head.role));
 assert.ok(units.find(c=>c.head?.role==='getter'&&c.changeType==='body_changed'));
});
test('multiline async signatures, decorators, import item bindings and uncertain conditional imports',()=>{
 const units=changes('async def f(\n x,\n): return x\nfrom pkg.foo import Bar as Baz, Other\n','@decorate\nasync def f(\n x, y,\n): return x\nfrom pkg.foo import Changed as Baz, Other\nif TYPE_CHECKING:\n from pkg import Thing\n');
 assert.ok(units.some(c=>c.changeType==='signature_changed'&&c.head.async));
 const item=units.find(c=>c.head?.name==='Baz');assert.equal(item.changeType,'import_changed');assert.equal(item.head.importItem.importedName,'Changed');
 assert.equal(item.head.importItem.localBinding,'Baz');assert.ok(units.find(c=>c.head?.name==='Thing').head.importItem.uncertain);
 assert.ok(!declarationSignals(units).some(s=>s.targetHint==='Other'));
});
test('indistinguishable duplicate definitions stay ambiguous instead of positional pairing',()=>{
 const units=changes('def f(): pass\ndef f(): pass\n','def f(x): pass\ndef f(): pass\n');assert.ok(units.every(c=>c.match==='ambiguous'));
});
test('receiver navigation accepts bound local receivers but rejects rebind, static and nested scope',()=>{
 const source='class C:\n def f(self):\n  self.foo()\n def rebound(self):\n  self = other\n  self.foo()\n @staticmethod\n def static(self): self.foo()\n @classmethod\n def classcall(cls): cls.foo()\n def nested(self):\n  def inner(self): self.foo()\n def foo(self): pass\n';
 assert.deepEqual(parser.receiverCalls(source).map(c=>c.callerLine),[2,10]);
});

test('new wildcard item is explicit and uncertain without confusing unchanged wildcard imports',()=>{
 const units=changes('from .a import *\nfrom .b import *\n','from .a import *\nfrom .stats import *\nfrom .b import *\n');
 const signals=declarationSignals(units);assert.equal(signals.length,1);assert.equal(signals[0].change.head.importItem.module,'stats');assert.equal(signals[0].change.head.importItem.uncertain,true);
});
