/**
 * Language-neutral graph conformance (ADR 0022 seam 6). Each case states one rule once; every language
 * supplies its own spelling of the fixture, or declares the case not supported. Expectations name
 * entities by `path#name` so they hold across languages.
 *   edges:   relations that must exist (definite)
 *   absent:  relations that must not exist
 */
export const CASES = [
  { id: 'same_name_isolation', rule: 'two definitions with one name stay distinct; a call reaches only the imported one',
    edges: [['CALLS', 'use#run', 'local#save']], absent: [['CALLS', 'use#run', 'remote#save']] },
  { id: 'alias_import', rule: 'an aliased import resolves to the original definition',
    edges: [['CALLS', 'use#run', 'lib#helper']] },
  { id: 'parameter_shadowing', rule: 'a parameter shadowing a module function leaves the call unresolved',
    edges: [], absent: [['CALLS', 'use#run', 'lib#helper']] },
  { id: 'cyclic_imports', rule: 'cyclic imports terminate and still resolve definite calls',
    edges: [['CALLS', 'a#first', 'b#second'], ['CALLS', 'b#second', 'a#leaf']] },
  { id: 'external_dependency', rule: 'a call into a module outside the snapshot is not an edge',
    edges: [], absent: [['CALLS', 'use#run', '*']] },
  { id: 'dynamic_receiver', rule: 'a method call on an untyped receiver is not resolved',
    edges: [], absent: [['CALLS', 'use#run', 'lib#helper']] },
  { id: 'inheritance', rule: 'a class extending an imported class gets an INHERITS edge',
    edges: [['INHERITS', 'use#Child', 'lib#Base']] },
  { id: 'syntax_error', rule: 'a file with syntax errors contributes no semantic edges',
    edges: [], absent: [['CALLS', 'use#run', 'lib#helper']] },
];

export const FIXTURES = {
  python: {
    same_name_isolation: { 'local.py': 'def save():\n    return 1\n', 'remote.py': 'def save():\n    return 2\n', 'use.py': 'from local import save\n\ndef run():\n    return save()\n' },
    alias_import: { 'lib.py': 'def helper():\n    return 1\n', 'use.py': 'from lib import helper as h\n\ndef run():\n    return h()\n' },
    parameter_shadowing: { 'lib.py': 'def helper():\n    return 1\n', 'use.py': 'from lib import helper\n\ndef run(helper):\n    return helper()\n' },
    cyclic_imports: { 'a.py': 'import b\n\ndef first():\n    return b.second()\n\ndef leaf():\n    return 0\n', 'b.py': 'import a\n\ndef second():\n    return a.leaf()\n' },
    external_dependency: { 'use.py': 'import requests\n\ndef run():\n    return requests.get("x")\n' },
    dynamic_receiver: { 'lib.py': 'def helper():\n    return 1\n', 'use.py': 'def run(obj):\n    return obj.helper()\n' },
    inheritance: { 'lib.py': 'class Base:\n    pass\n', 'use.py': 'from lib import Base\n\nclass Child(Base):\n    pass\n' },
    syntax_error: { 'lib.py': 'def helper():\n    return 1\n', 'use.py': 'from lib import helper\n\ndef run(:\n    return helper()\n' },
  },
  typescript: {
    same_name_isolation: { 'local.ts': 'export function save() { return 1; }\n', 'remote.ts': 'export function save() { return 2; }\n', 'use.ts': "import { save } from './local';\nexport function run() { return save(); }\n" },
    alias_import: { 'lib.ts': 'export function helper() { return 1; }\n', 'use.ts': "import { helper as h } from './lib';\nexport function run() { return h(); }\n" },
    parameter_shadowing: { 'lib.ts': 'export function helper() { return 1; }\n', 'use.ts': "import { helper } from './lib';\nexport function run(helper: () => number) { return helper(); }\n" },
    cyclic_imports: { 'a.ts': "import * as b from './b';\nexport function first() { return b.second(); }\nexport function leaf() { return 0; }\n", 'b.ts': "import * as a from './a';\nexport function second() { return a.leaf(); }\n" },
    external_dependency: { 'use.ts': "import axios from 'axios';\nexport function run() { return axios.get('x'); }\n" },
    dynamic_receiver: { 'lib.ts': 'export function helper() { return 1; }\n', 'use.ts': 'export function run(obj: any) { return obj.helper(); }\n' },
    inheritance: { 'lib.ts': 'export class Base {}\n', 'use.ts': "import { Base } from './lib';\nexport class Child extends Base {}\n" },
    syntax_error: { 'lib.ts': 'export function helper() { return 1; }\n', 'use.ts': "import { helper } from './lib';\nexport function run( { return helper(); }\n" },
  },
};
