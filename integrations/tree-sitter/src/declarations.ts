import type { Node, Parser } from 'web-tree-sitter';
import { digest, type Declaration } from '../../../src/engine/declarations.ts';

/** CST-only extraction. Never executes reviewed Python. Source bodies are hashes,
 * not extra model context or evidence. */
export function declarations(parser: Parser, path: string, source: string) {
  const tree=parser.parse(source); if(!tree) throw Error('Missing declaration parse');
  const result: Declaration[]=[];
  const field=(n:Node,k:string)=>n.childForFieldName(k);
  const canonical=(n:Node):unknown=>n.type==='comment'?null:n.children.length ? [n.type,...n.children.filter(c=>c.type!=='comment').map(canonical)] : [n.type,n.text];
  const own=(n:Node):unknown=>['function_definition','class_definition','decorated_definition'].includes(n.type)?['nested_declaration']
    : n.type==='comment'?null:n.children.length?[n.type,...n.children.filter(c=>c.type!=='comment').map(own)]:[n.type,n.text];
  const range=(n:Node)=>({startLine:n.startPosition.row+1,endLine:n.endPosition.row+1});
  const walk=(n:Node,scope:string,parentKind:string,conditional=false):void=>{
    if(n.type==='decorated_definition') {const d=n.namedChildren.find(c=>['function_definition','class_definition'].includes(c.type));if(d)walk(d,scope,parentKind,conditional);return;}
    if(['function_definition','class_definition'].includes(n.type)) {
      const name=field(n,'name')?.text; if(!name)return;
      const decorators=n.parent?.type==='decorated_definition'?n.parent.namedChildren.filter(c=>c.type==='decorator'):[];
      const deco=decorators.map(d=>d.text.replace(/\s+/g,''));
      const role:Declaration['role']=deco.includes('@property')?'getter':deco.includes('@'+name+'.setter')?'setter':deco.includes('@'+name+'.deleter')?'deleter':'none';
      const kind:Declaration['kind']=n.type==='class_definition'?'class':parentKind==='class'?'method':'function';
      const body=field(n,'body'),parameters=field(n,kind==='class'?'superclasses':'parameters');
      const async=n.children.some(c=>c.type==='async');
      result.push({path,scope,kind,name,role,async,range:range(decorators.length?n.parent!:n),definitionLine:n.startPosition.row+1,
        identity:digest([path,scope,kind,name,role]),signature:digest([async,parameters?canonical(parameters):null,field(n,'return_type')?canonical(field(n,'return_type')!):null]),
        decorators:digest(decorators.map(canonical)),body:digest(body?own(body):null),structure:digest(canonical(n)),
        segments:[{part:'signature',hash:digest([async,parameters?canonical(parameters):null,field(n,'return_type')?canonical(field(n,'return_type')!):null]),range:{startLine:n.startPosition.row+1,endLine:parameters?.endPosition.row!==undefined?parameters.endPosition.row+1:n.startPosition.row+1}},
          ...decorators.map(d=>({part:'decorator' as const,hash:digest(canonical(d)),range:range(d)})),
          ...(body?.namedChildren??[]).filter(c=>c.type!=='comment').map(c=>({part:'body' as const,hash:digest(own(c)),range:range(c)}))]});
      if(body)walk(body,[scope,name+(role==='none'?'':':'+role)].filter(Boolean).join('.'),kind,false); return;
    }
    if(['import_statement','import_from_statement'].includes(n.type)) {
      const from=n.type==='import_from_statement', moduleNode=field(n,'module_name'),raw=moduleNode?.text??'';
      const level=raw.length-raw.replace(/^\.+/,'').length;
      for(const item of n.namedChildren.filter(c=>c.id!==moduleNode?.id && ['dotted_name','aliased_import','wildcard_import'].includes(c.type))) {
        const name=(field(item,'name')??item).text,alias=field(item,'alias')?.text??(from?name:name.split('.')[0]!);
        const module=from?raw.slice(level):name;
        const importItem={module,...(from?{importedName:name}:{}),localBinding:alias,relativeLevel:level,reexport:scope===''&&path.endsWith('__init__.py'),uncertain:conditional||name==='*'};
        const kind=from?'from_import' as const:'import' as const;
        result.push({path,scope,kind,name:alias,role:'none',async:false,range:range(n),definitionLine:n.startPosition.row+1,
          identity:digest([path,scope,kind,alias,'none',alias==='*'?module:null]),signature:digest(importItem),decorators:digest([]),body:digest(null),structure:digest(canonical(item)),segments:[{part:'import',hash:digest(importItem),range:range(n)}],importItem});
      }
      return;
    }
    const branch=conditional||['if_statement','try_statement','for_statement','while_statement','with_statement'].includes(n.type);
    for(const child of n.namedChildren)walk(child,scope,parentKind,branch);
  };
  try {walk(tree.rootNode,'','module');return {declarations:result,parseComplete:!tree.rootNode.hasError};} finally {tree.delete();}
}

/** Local receiver navigation facts only; never returned as definite CALLS. */
export function receiverCalls(parser:Parser,source:string) {
  const tree=parser.parse(source); if(!tree)throw Error('Missing receiver parse');
  const result:{callerLine:number;classLine:number;member:string;line:number}[]=[];
  const field=(n:Node,k:string)=>n.childForFieldName(k);
  const find=(n:Node,owner?:Node):void=>{
    if(n.type==='class_definition'){for(const c of field(n,'body')?.namedChildren??[])find(c,n);return;}
    if(n.type==='function_definition'){
      if(!owner)return;
      const parameters=field(n,'parameters'), first=parameters?.namedChildren[0], receiver=first?.type==='identifier'?first.text:first?field(first,'name')?.text:undefined;
      const decorators=n.parent?.type==='decorated_definition'?n.parent.namedChildren.filter(c=>c.type==='decorator').map(c=>c.text.replace(/\s+/g,'')):[];
      if(!['self','cls'].includes(receiver??'') || decorators.includes('@staticmethod') || receiver==='cls'&&!decorators.includes('@classmethod'))return;
      let rebound=false;const calls:typeof result=[];
      const target=(x:Node|null):boolean=>!!x&&(x.type==='identifier'?x.text===receiver:['attribute','subscript'].includes(x.type)?false:x.namedChildren.some(target));
      const scan=(x:Node):void=>{
        if(['function_definition','class_definition','lambda'].includes(x.type))return;
        if(['global_statement','nonlocal_statement','match_statement'].includes(x.type))rebound=true;
        if(['assignment','augmented_assignment','named_expression','for_statement','for_in_clause'].includes(x.type) && target(field(x,'left')??field(x,'name')))rebound=true;
        if(x.type==='as_pattern'&&target(field(x,'alias')))rebound=true;
        if(x.type==='delete_statement'&&x.namedChildren.some(target))rebound=true;
        if(x.type==='call') {
          const fn=field(x,'function');
          if(fn?.type==='identifier'&&['exec','eval'].includes(fn.text))rebound=true;
          if(fn?.type==='attribute'&&field(fn,'object')?.type==='identifier'&&field(fn,'object')?.text===receiver)
            calls.push({callerLine:n.startPosition.row+1,classLine:owner!.startPosition.row+1,member:field(fn,'attribute')!.text,line:x.startPosition.row+1});
        }
        for(const c of x.namedChildren)scan(c);
      };
      const body=field(n,'body');if(body)scan(body);if(!rebound)result.push(...calls);return;
    }
    for(const c of n.namedChildren)find(c,owner);
  };
  try{if(!tree.rootNode.hasError)find(tree.rootNode);return result;}finally{tree.delete();}
}
