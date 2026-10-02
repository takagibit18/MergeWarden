import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
import {read,save,checkIdentities} from './candidate-dataset-context.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'..'),phase=join(out,'phase-b'),phaseName=process.argv[3]??'phase-a';assert(/^phase-a(?:-v\d+)?$/.test(phaseName));const freeze=await read(join(out,phaseName,'counterfactual-freeze.json'));
await checkIdentities(freeze.files);
const allowed=[join(repo,'src'),join(repo,'package.json'),...['route-utility-score.mjs','route-utility-rubric.mjs','candidate-dataset-context.mjs'].map(f=>join(repo,'eval',f)),join(out,phaseName),phase,join(out,'universe.json'),...freeze.files.map(f=>f.path)];
await save(join(out,'phase-b-access-policy.json'),{read:allowed,write:[phase],phaseAWriteAllowed:false,predictionsReadAllowed:false});
const child=spawnSync(process.execPath,['--experimental-strip-types','--preserve-symlinks','--permission',...[...new Set(allowed)].map(p=>'--allow-fs-read='+p),'--allow-fs-write='+phase,join(repo,'eval/route-utility-score.mjs'),out,phaseName],{cwd:repo,encoding:'utf8',maxBuffer:2e6});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0);
await checkIdentities(freeze.files);await checkIdentities(await read(join(out,'historical-identities.json')));
