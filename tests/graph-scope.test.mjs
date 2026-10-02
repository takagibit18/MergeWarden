import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPythonPath,pythonCatalog} from '../src/graph/scope-policy.ts';
const file={hash:'a'.repeat(64),bytes:1,status:'text',mode:'100644'};
test('file scope classification is component based and changed tests stay core',()=>{
 assert.equal(classifyPythonPath('src/contest.py'),'production');assert.equal(classifyPythonPath('src/test_helper.py'),'test');assert.equal(classifyPythonPath('pkg/tests/helpers.py'),'test');assert.equal(classifyPythonPath('examples/run.py'),'example');assert.equal(classifyPythonPath('third_party/lib.py'),'vendor');assert.equal(classifyPythonPath('api_pb2.py'),'generated');assert.equal(classifyPythonPath('sympy/integrals/rubi/rules/trig.py'),'generated');assert.equal(classifyPythonPath('pkg/rules/trig.py'),'production');
 const catalog=pythonCatalog({'src/contest.py':file,'tests/test_changed.py':file,'tests/test_old.py':file,'examples/run.py':file},['tests/test_changed.py']);
 assert.deepEqual(catalog.map(row=>[row.path,row.layer,row.included]),[['tests/test_changed.py','changed',true],['src/contest.py','production',true],['examples/run.py','supplemental',false],['tests/test_old.py','supplemental',false]]);
});
