import {spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
const repo=resolve(import.meta.dirname,'../..'),root=resolve(process.argv[2]),auth=resolve(process.argv[3]),phase=process.argv[4];
const reads=['src','node_modules','integrations/pi','integrations/tree-sitter','eval/skills'].map(p=>join(repo,p));reads.push(join(root,'execution'),dirname(auth));if(phase==='C')reads.push(join(root,'evaluation/comments-validated.json'));
const child=spawn(process.execPath,['--experimental-strip-types','--permission',...reads.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(root,'execution'),'--allow-fs-write='+dirname(auth),join(repo,'eval/skills/learn.mjs'),root,auth,phase],{stdio:'inherit',windowsHide:true});child.on('exit',code=>process.exitCode=code??1);
