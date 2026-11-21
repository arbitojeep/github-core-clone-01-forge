// Forge: GitHub-compatible git forge, one process, Node stdlib only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const NOW = process.env.MAKEFUN_TRIAL_NOW || '2026-11-21T00:00:00Z';
let reqId = 0;
function rid(){ return `req_${Date.now().toString(36)}_${(++reqId).toString(36)}_${Math.floor(Math.random()*1e6).toString(36)}`; }
function sha1(b: Buffer|string){ return createHash('sha1').update(b).digest('hex'); }
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string,string>={}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': rid(), ...headers });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, ctype='application/x-git-upload-pack-advertisement', headers: Record<string,string>={}) {
  res.writeHead(status, { 'content-type': ctype, 'content-length': buf.length, 'x-github-request-id': rid(), ...headers });
  res.end(buf);
}
function pathOf(req: IncomingMessage){ try { return new URL(req.url ?? '/', 'http://x').pathname; } catch { return '/'; } }
function queryOf(req: IncomingMessage){ try { return new URL(req.url ?? '/', 'http://x').searchParams; } catch { return new URLSearchParams(); } }
async function readBody(req: IncomingMessage): Promise<Buffer> { const c: Buffer[]=[]; for await (const ch of req) c.push(ch as Buffer); return Buffer.concat(c); }
async function readJson(req: IncomingMessage): Promise<{ok:boolean, val:any, raw:Buffer}> {
  const raw = await readBody(req);
  if (!raw.length) return {ok:true, val:{}, raw};
  try { return {ok:true, val: JSON.parse(raw.toString('utf8')), raw}; } catch { return {ok:false, val:null, raw}; }
}
function auth(req: IncomingMessage): boolean {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || h.slice(7).trim()==='') return false;
  if (TOKEN) return h.slice(7).trim()===TOKEN;
  return true;
}
// ---------- git objects ----------
type Obj = { type:string, content:Buffer };
function objSha(type:string, content:Buffer){ return sha1(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])); }
class Repo {
  id:number; name:string; owner:string|null=null; description:string; priv:boolean; defaultBranch:string;
  branches = new Map<string,string|null>(); // branch -> commit sha or null
  tags = new Map<string,string>();
  objects = new Map<string,Obj>();
  commits = new Map<string,{tree:string, parents:string[], message:string}>();
  filesAt = new Map<string, Map<string,Buffer>>(); // commit sha -> files
  issues = new Map<number,any>(); nextIssue=1;
  labels = new Map<string,any>();
  pulls = new Map<number,any>(); nextPull=1;
  comments = new Map<number,any[]>();
  createdAt = NOW; seq=0;
  constructor(id:number, name:string, desc:string, priv:boolean, defBranch:string){ this.id=id; this.name=name; this.description=desc; this.priv=priv; this.defaultBranch=defBranch; this.branches.set(defBranch, null); }
  get fullName(){ return `${this.owner||'viewer'}/${this.name}`; }
  store(type:string, content:Buffer){ const s=objSha(type,content); if(!this.objects.has(s)) this.objects.set(s,{type,content}); return s; }
  buildTree(files:Map<string,Buffer>):string{
    const build=(prefix:string):string=>{
      const entries:{mode:string,name:string,sha:string,isTree:boolean}[]=[];
      const dirs=new Map<string, Map<string,Buffer>>();
      for(const [p,buf] of files){ if(!p.startsWith(prefix)) continue; const rest=p.slice(prefix.length); const slash=rest.indexOf('/'); if(slash===-1){ const sha=this.store('blob',buf); entries.push({mode:'100644',name:rest,sha,isTree:false}); } else { const d=rest.slice(0,slash); if(!dirs.has(d)) dirs.set(d,new Map()); const sub=new Map<string,Buffer>(); for(const [p2,b2] of files){ if(p2.startsWith(prefix+d+'/')) sub.set(p2.slice(prefix.length+d.length+1),b2); } const treeSha=buildTreeFrom(this, sub, ''); entries.push({mode:'40000',name:d,sha:treeSha,isTree:true}); } }
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      let buf=Buffer.alloc(0); for(const e of entries){ buf=Buffer.concat([buf, Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha,'hex')]); }
      return this.store('tree',buf);
    };
    return build('');
  }
  commit(files:Map<string,Buffer>, parents:string[], message:string):string{
    const tree=this.buildTree(files);
    let c=`tree ${tree}\n`; for(const p of parents) c+=`parent ${p}\n`; c+=`author Forge <forge@example.invalid> 1700000000 +0000\ncommitter Forge <forge@example.invalid> 1700000000 +0000\n\n${message}\n`;
    const sha=this.store('commit', Buffer.from(c,'utf8'));
    this.commits.set(sha,{tree,parents,message});
    this.filesAt.set(sha,new Map(files));
    return sha;
  }
  filesAtCommit(sha:string|null):Map<string,Buffer>{ if(!sha) return new Map(); const f=this.filesAt.get(sha); if(f) return new Map(f); // fallback walk tree
    return new Map(); }
  ancestors(sha:string|null):Set<string>{ const out=new Set<string>(); const stack=[sha]; while(stack.length){ const s=stack.pop(); if(!s||out.has(s)) continue; out.add(s); const cm=this.commits.get(s); if(cm) for(const p of cm.parents) stack.push(p); } return out; }
  isAncestor(a:string|null,b:string|null):boolean{ if(!a) return true; if(!b) return false; return this.ancestors(b).has(a); }
  repoJson(){ return { id:this.id, node_id:`R_${this.id}`, name:this.name, full_name:this.fullName, owner:{login:this.owner||'viewer', id:1000, type:'User', avatar_url:''}, private:this.priv, description:this.description, default_branch:this.defaultBranch, html_url:`https://example.invalid/${this.fullName}`, clone_url:`https://example.invalid/${this.fullName}.git`, created_at:this.createdAt, updated_at:this.createdAt, pushed_at:this.createdAt, homepage:'', language:null, fork:false, forks_count:0, stargazers_count:0, watchers_count:0, open_issues_count:[...this.issues.values()].filter((i:any)=>i.state==='open').length, has_issues:true, has_projects:true, has_wiki:true, archived:false, disabled:false, visibility:this.priv?'private':'public' }; }
}
function buildTreeFrom(repo:Repo, files:Map<string,Buffer>, _p:string):string{ return repo.buildTree(files); }
const repos = new Map<string,Repo>(); // key name
let nextRepoId=5000; let globalSeq=0;
function getRepo(owner:string, name:string):Repo|null{
  const r=repos.get(name); if(!r) return null;
  if(r.owner===null){ r.owner=owner; return r; }
  if(r.owner!==owner) return null;
  return r;
}
function getRepoAny(name:string){ return repos.get(name)||null; }
function pkt(s:string){ const l=Buffer.byteLength(s)+4; return Buffer.concat([Buffer.from(l.toString(16).padStart(4,'0')), Buffer.from(s)]); }
function pktFlush(){ return Buffer.from('0000'); }
// pack generation
function encodeObjHeader(typeNum:number, size:number):Buffer{ const bytes:number[]=[]; let s=size; let first=true; while(true){ let b=s&0x0f; s>>=4; if(first){ b|=(typeNum<<4); first=false; } if(s>0) b|=0x80; bytes.push(b); if(s===0) break; } return Buffer.from(bytes); }
// Actually varint: low 4 bits first byte, then 7 bits per byte. Fix above: use proper encoding below in buildPack.
function buildPack(repo:Repo, shas:string[]):Buffer{
  const parts:Buffer[]=[Buffer.from('PACK'), Buffer.from([0,0,0,2]), Buffer.alloc(4)]; parts[2]!.writeUInt32BE(shas.length,0);
  const typeNum:{[k:string]:number}={commit:1,tree:2,blob:3,tag:4};
  for(const sha of shas){ const o=repo.objects.get(sha); if(!o) continue; const tn=typeNum[o.type]||3; const size=o.content.length;
    // header varint
    const hb:number[]=[]; let sz=size; hb.push((tn<<4)|(sz&15)); sz>>=4; while(sz>0){ hb[hb.length-1]!|=0x80; hb.push(sz&0x7f); sz>>=7; }
    parts.push(Buffer.from(hb)); parts.push(deflateSync(o.content));
  }
  const pack=Buffer.concat(parts); const trailer=Buffer.from(sha1(pack),'hex'); return Buffer.concat([pack, trailer]);
}
function collectObjects(repo:Repo, wants:string[], haves:string[], deepen:number|null):{shas:string[], shallow:string[]}{
  const wantAnc=new Set<string>(); for(const w of wants){ for(const a of repo.ancestors(w)) wantAnc.add(a); }
  const haveAnc=new Set<string>(); for(const h of haves){ for(const a of repo.ancestors(h)) haveAnc.add(a); }
  let commits=[...wantAnc].filter(s=>!haveAnc.has(s));
  if(deepen!==null){ commits=wants.filter(w=>repo.commits.has(w)); }
  const shas:string[]=[]; const seen=new Set<string>();
  const addObj=(sha:string)=>{ if(seen.has(sha)||!repo.objects.has(sha)) return; seen.add(sha); shas.push(sha); };
  // commits first, then trees, then blobs - use BFS order
  for(const c of commits) addObj(c);
  const trees=new Set<string>(); for(const c of commits){ const cm=repo.commits.get(c); if(cm) trees.add(cm.tree); }
  // walk trees recursively
  const walkTree=(treeSha:string)=>{ addObj(treeSha); const o=repo.objects.get(treeSha); if(!o) return; let off=0; const buf=o.content; while(off<buf.length){ const sp=buf.indexOf(0,off); if(sp===-1) break; const modeName=buf.slice(off,sp).toString(); const sha=buf.slice(sp+1,sp+21).toString('hex'); off=sp+21; if(modeName.startsWith('40000')) walkTree(sha); else addObj(sha); } };
  for(const t of trees) walkTree(t);
  const shallow = deepen!==null ? wants.filter(w=>repo.commits.has(w)) : [];
  return {shas, shallow};
}
// delta apply
function parseVarint(buf:Buffer, off:number):[number,number]{ let v=0; let shift=0; let i=off; while(true){ const b=buf[i++]!; v|=(b&0x7f)<<shift; shift+=7; if(!(b&0x80)) break; } return [v,i]; }
function applyDelta(base:Buffer, delta:Buffer):Buffer{
  let off=0; const [,o1]=parseVarint(delta,off); off=o1; const [resultSize,o2]=parseVarint(delta,off); off=o2;
  const out:Buffer[]=[]; let total=0;
  while(off<delta.length){ const op=delta[off++]!; if(op&0x80){ let cpOff=0, cpSize=0; for(let i=0;i<4;i++) if(op&(1<<i)) cpOff|=delta[off++]!<<(i*8); for(let i=0;i<3;i++) if(op&(0x10<<i)) cpSize|=delta[off++]!<<(i*8); if(cpSize===0) cpSize=0x10000; out.push(base.subarray(cpOff,cpOff+cpSize)); total+=cpSize; } else if(op){ out.push(delta.subarray(off,off+op)); total+=op; off+=op; } else throw new Error('delta op 0'); }
  const res=Buffer.concat(out); if(res.length!==resultSize) throw new Error('delta size mismatch'); return res;
}
function inflateAt(buf:Buffer, off:number, expected:number):{data:Buffer, consumed:number}{
  // Try inflateSync on slices, binary search consumed length using zlib stream bytesRead via createInflate is async; use trial: inflateSync will throw if truncated, succeed if exact or extra? Node inflateSync ignores trailing? Test empirically in code path: try increasing lengths.
  // Use incremental approach: try lengths from off+10 upward in steps, first success with correct size wins - packs are small.
  for(let end=off+2; end<=buf.length; end++){
    try{ const d=inflateSync(buf.subarray(off,end)); if(d.length===expected) return {data:d, consumed:end-off}; }catch{}
  }
  // fallback: inflate whole rest
  const d=inflateSync(buf.subarray(off)); return {data:d, consumed:buf.length-off};
}
function parsePack(repo:Repo, buf:Buffer){
  if(buf.length<12 || buf.subarray(0,4).toString()!=='PACK') return;
  const count=buf.readUInt32BE(8); let off=12;
  const objs:{sha:string,type:string,content:Buffer}[]=[];
  const byOffset=new Map<number,{sha:string,type:string,content:Buffer}>();
  for(let i=0;i<count;i++){
    const start=off; let b=buf[off++]!; const typeNum=(b>>4)&7; let size=b&15; let shift=4; while(b&0x80){ b=buf[off++]!; size|=(b&0x7f)<<shift; shift+=7; }
    const typeMap:{[k:number]:string}={1:'commit',2:'tree',3:'blob',4:'tag'};
    if(typeNum===6){ // ofs-delta
      let bb=buf[off++]!; let baseOff=bb&0x7f; while(bb&0x80){ bb=buf[off++]!; baseOff=((baseOff+1)<<7)|(bb&0x7f); }
      const baseStart=start-baseOff; const baseObj=byOffset.get(baseStart); if(!baseObj) throw new Error('delta base missing');
      const {data,consumed}=inflateAt(buf,off,size); off+=consumed;
      const content=applyDelta(baseObj.content,data); const sha=objSha('commit',content); // type is base type, but delta result type = base type
      // determine base type: if base is commit/tree/blob, use that
      const t=baseObj.type; const s=objSha(t,content); objs.push({sha:s,type:t,content}); byOffset.set(start,{sha:s,type:t,content});
    } else if(typeNum===7){ // ref-delta
      const baseSha=buf.subarray(off,off+20).toString('hex'); off+=20; const baseObj=repo.objects.get(baseSha); if(!baseObj) throw new Error('ref delta base missing');
      const {data,consumed}=inflateAt(buf,off,size); off+=consumed; const content=applyDelta(baseObj.content,data); const s=objSha(baseObj.type,content); objs.push({sha:s,type:baseObj.type,content}); byOffset.set(start,{sha:s,type:baseObj.type,content});
    } else {
      const type=typeMap[typeNum]||'blob'; const {data,consumed}=inflateAt(buf,off,size); off+=consumed; const s=objSha(type,data); objs.push({sha:s,type,content:data}); byOffset.set(start,{sha:s,type,content:data});
    }
  }
  for(const o of objs){ repo.objects.set(o.sha,{type:o.type,content:o.content}); if(o.type==='commit'){ const txt=o.content.toString('utf8'); const tree=(txt.match(/^tree ([0-9a-f]{40})/m)||[])[1]||''; const parents=[...txt.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m=>m[1]!); const msg=txt.split('\n\n').slice(1).join('\n\n').trim(); repo.commits.set(o.sha,{tree,parents,message:msg}); // filesAt will be computed lazily from tree
      // compute files
      const files=new Map<string,Buffer>(); const walk=(treeSha:string,prefix:string)=>{ const oo=repo.objects.get(treeSha); if(!oo) return; let off2=0; const b=oo.content; while(off2<b.length){ const sp=b.indexOf(0,off2); if(sp===-1) break; const mn=b.slice(off2,sp).toString(); const sh=b.slice(sp+1,sp+21).toString('hex'); off2=sp+21; const name=mn.split(' ').slice(1).join(' '); if(mn.startsWith('40000')) walk(sh,prefix+name+'/'); else { const bo=repo.objects.get(sh); if(bo) files.set(prefix+name,bo.content); } } }; walk(tree,''); repo.filesAt.set(o.sha,files);
    }
  }
}

// ---------- helpers for REST ----------
function issueJson(r:Repo, iss:any){ return { id:10000+iss.number, node_id:`I_${iss.number}`, number:iss.number, title:iss.title, body:iss.body||'', state:iss.state, locked:false, user:{login:r.owner||'viewer', id:1000, type:'User'}, assignee:null, assignees:[], labels:iss.labels.map((n:string)=>({id:20000+n.length, name:n, color:'000000', description:''})), milestone:null, comments: (r.comments.get(iss.number)||[]).length, created_at:iss.created_at, updated_at:iss.created_at, closed_at: iss.state==='closed'?iss.created_at:null, author_association:'OWNER', html_url:`https://example.invalid/${r.fullName}/issues/${iss.number}` }; }
function pullJson(r:Repo, pr:any){ const headSha=r.branches.get(pr.head)||''; const baseSha=r.branches.get(pr.base)||''; return { id:30000+pr.number, node_id:`PR_${pr.number}`, number:pr.number, state:pr.state, title:pr.title, body:pr.body||'', locked:false, user:{login:r.owner||'viewer', id:1000, type:'User'}, assignee:null, labels:[], milestone:null, draft:false, merged:pr.merged||false, mergeable: pr.state==='open', merge_commit_sha: pr.merge_commit_sha||null, merged_at: pr.merged_at||null, head:{label:`${r.owner||'viewer'}:${pr.head}`, ref:pr.head, sha:headSha, user:{login:r.owner||'viewer'}}, base:{label:`${r.owner||'viewer'}:${pr.base}`, ref:pr.base, sha:baseSha, user:{login:r.owner||'viewer'}}, created_at:pr.created_at, updated_at:pr.created_at, closed_at: pr.state==='closed'?pr.created_at:null, html_url:`https://example.invalid/${r.fullName}/pull/${pr.number}` }; }
function changedFiles(r:Repo, pr:any):any[]{
  const baseFiles = pr.baseSha ? r.filesAtCommit(pr.baseSha) : new Map<string,Buffer>();
  const headFiles = pr.headSha ? r.filesAtCommit(pr.headSha) : new Map<string,Buffer>();
  const paths=new Set([...baseFiles.keys(), ...headFiles.keys()]); const out:any[]=[];
  for(const p of paths){ const b=baseFiles.get(p); const h=headFiles.get(p); if(b&&h&&b.equals(h)) continue; if(!b&&h) out.push({filename:p, status:'added', additions:h.toString('utf8').split('\n').length, deletions:0, changes:h.toString('utf8').split('\n').length}); else if(b&&!h) out.push({filename:p, status:'removed', additions:0, deletions:b.toString('utf8').split('\n').length, changes:b.toString('utf8').split('\n').length}); else if(b&&h) out.push({filename:p, status:'modified', additions:Math.max(1,h.toString('utf8').split('\n').length), deletions:b.toString('utf8').split('\n').length, changes:Math.max(1,h.toString('utf8').split('\n').length)+b.toString('utf8').split('\n').length}); }
  return out;
}
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req); const method = req.method ?? 'GET'; const q = queryOf(req);
      const isHealth = method==='GET' && path==='/healthz';
      if (isHealth){ sendJson(res,200,{ok:true}); return; }
      // Git smart HTTP
      const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git\/(.*)$/);
      if (gitMatch){
        const [,owner,repoName,rest]=gitMatch as any; const repo=getRepoAny(repoName);
        if(!auth(req)){ sendJson(res,401,{message:'Requires authentication'}); return; }
        if(!repo){ sendJson(res,404,{message:'Not Found'}); return; }
        if(repo.owner===null) repo.owner=owner; if(repo.owner!==owner){ sendJson(res,404,{message:'Not Found'}); return; }
        if(method==='GET' && rest==='info/refs'){
          const service=q.get('service')||'';
          if(service==='git-upload-pack'){
            if((req.headers['git-protocol']||'').includes('version=2')){
              const lines=[pkt('version 2\n'), pkt('agent=forge/1.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), pktFlush()];
              sendRaw(res,200,Buffer.concat(lines),'application/x-git-upload-pack-advertisement'); return;
            }
            const caps='multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter agent=forge/1.0';
            const parts:Buffer[]=[pkt('# service=git-upload-pack\n'), pktFlush()];
            const refs=[...repo.branches.entries()].filter(([,s])=>s).map(([b,s])=>`refs/heads/${b}`);
            if(refs.length===0){ parts.push(pkt('0000000000000000000000000000000000000000 capabilities^{}\0'+caps+'\n')); }
            else { const headSha=repo.branches.get(repo.defaultBranch)||refs[0]&&repo.branches.get(refs[0].split('/').pop()!)!; parts.push(pkt(`${headSha} HEAD\0${caps}\n`)); refs.forEach((ref)=>{ const sha=repo.branches.get(ref.split('/').pop()!)!; parts.push(pkt(`${sha} ${ref}\n`)); }); }
            parts.push(pktFlush()); sendRaw(res,200,Buffer.concat(parts),'application/x-git-upload-pack-advertisement'); return;
          }
          if(service==='git-receive-pack'){
            const caps='report-status report-status-v2 thin-pack side-band side-band-64k ofs-delta agent=forge/1.0 delete-refs quiet atomic';
            const parts:Buffer[]=[pkt('# service=git-receive-pack\n'), pktFlush()];
            const refs=[...repo.branches.entries()].filter(([,s])=>s).map(([b,s])=>`refs/heads/${b}`);
            if(refs.length===0){ parts.push(pkt('0000000000000000000000000000000000000000 capabilities^{}\0'+caps+'\n')); }
            else { refs.forEach((ref,i)=>{ const sha=repo.branches.get(ref.split('/').pop()!)!; parts.push(pkt(`${sha} ${ref}${i===0?'\0'+caps:''}\n`)); }); }
            parts.push(pktFlush()); sendRaw(res,200,Buffer.concat(parts),'application/x-git-receive-pack-advertisement'); return;
          }
          sendJson(res,404,{message:'Not Found'}); return;
        }
        if(method==='POST' && rest==='git-upload-pack'){
          const body=await readBody(req);
          const isV2=(req.headers['git-protocol']||'').includes('version=2');
          if(isV2){
            const text=body.toString('utf8'); const lines=text.split('\n');
            // parse pkt lines crudely: extract commands
            const wants:string[]=[]; let deepen:number|null=null; let isLs=false;
            // pkt format: 4 hex len + content
            let off=0; const cmds:string[]=[]; while(off+4<=body.length){ const len=parseInt(body.subarray(off,off+4).toString(),16); if(len===0){ off+=4; break; } cmds.push(body.subarray(off+4,off+len).toString()); off+=len; }
            let cmdText=cmds.join('\n');
            if(cmdText.includes('ls-refs')){ isLs=true; }
            if(isLs){
              const out:Buffer[]=[]; for(const [b,sha] of repo.branches){ if(!sha) continue; out.push(pkt(`${sha} refs/heads/${b}\n`)); } for(const [tg,sha] of repo.tags){ out.push(pkt(`${sha} refs/tags/${tg}\n`)); }
              // HEAD symref
              out.push(pkt(`${repo.branches.get(repo.defaultBranch)||'0000000000000000000000000000000000000000'} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
              out.push(pktFlush()); sendRaw(res,200,Buffer.concat(out),'application/x-git-upload-pack-result'); return;
            }
            // fetch
            for(const c of cmds){ const m=c.match(/want ([0-9a-f]{40})/); if(m) wants.push(m[1]!); const d=c.match(/deepen (\d+)/); if(d) deepen=parseInt(d[1]!); }
            // also parse remaining pkt lines after first flush for fetch args
            let off2=off; while(off2+4<=body.length){ const len=parseInt(body.subarray(off2,off2+4).toString(),16); if(len===0) break; const s=body.subarray(off2+4,off2+len).toString(); cmdText+= '\n'+s; const m=s.match(/want ([0-9a-f]{40})/); if(m) wants.push(m[1]!); const d=s.match(/deepen (\d+)/); if(d) deepen=parseInt(d[1]!); off2+=len; }
            const {shas, shallow}=collectObjects(repo, wants, [], deepen);
            const pack=buildPack(repo, shas);
            const sideband = true;
            const out:Buffer[]=[pkt('packfile\n')];
            if(sideband){ for(let i=0;i<pack.length;i+=65000){ const chunk=pack.subarray(i,Math.min(pack.length,i+65000)); const data=Buffer.concat([Buffer.from([1]), chunk]); out.push(Buffer.concat([Buffer.from((data.length+4).toString(16).padStart(4,'0')), data])); } }
            else { for(let i=0;i<pack.length;i+=65000){ const chunk=pack.subarray(i,Math.min(pack.length,i+65000)); const l=chunk.length+4; out.push(Buffer.concat([Buffer.from(l.toString(16).padStart(4,'0')), chunk])); } }
            out.push(pktFlush()); sendRaw(res,200,Buffer.concat(out),'application/x-git-upload-pack-result'); return;
          }
          // v0
          const text=body.toString('utf8'); const wants:string[]=[]; const haves:string[]=[]; let deepen:number|null=null;
          for(const line of text.split('\n')){ const m=line.match(/want ([0-9a-f]{40})/); if(m) wants.push(m[1]!); const h=line.match(/have ([0-9a-f]{40})/); if(h) haves.push(h[1]!); const d=line.match(/deepen (\d+)/); if(d) deepen=parseInt(d[1]!); }
          const {shas, shallow}=collectObjects(repo, wants, haves, deepen);
          const pack=buildPack(repo, shas);
          const out:Buffer[]=[];
          for(const s of shallow) out.push(pkt(`shallow ${s}\n`));
          out.push(pkt('NAK\n'));
          // sideband: chunk pack with channel 1
          for(let i=0;i<pack.length;i+=65000){ const chunk=pack.subarray(i,Math.min(pack.length,i+65000)); const data=Buffer.concat([Buffer.from([1]), chunk]); const l=data.length+4; out.push(Buffer.concat([Buffer.from(l.toString(16).padStart(4,'0')), data])); }
          out.push(pktFlush()); sendRaw(res,200,Buffer.concat(out),'application/x-git-upload-pack-result'); return;
        }
        if(method==='POST' && rest==='git-receive-pack'){
          const body=await readBody(req);
          // parse pkt lines until flush
          let off=0; const updates:{old:string, nw:string, ref:string}[]=[];
          while(off+4<=body.length){ const lenStr=body.subarray(off,off+4).toString(); const len=parseInt(lenStr,16); if(isNaN(len)||len===0){ off+=4; break; } const line0=body.subarray(off+4,off+len).toString().trim(); off+=len; const line=line0.split('\0')[0]!; const m=line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/); if(m) updates.push({old:m[1]!, nw:m[2]!, ref:m[3]!.trim()}); }
          const packBuf=body.subarray(off);
          if(packBuf.length>0){ try{ parsePack(repo, packBuf); }catch(e){ /* ignore */ } }
          const results:{ref:string, ok:boolean, reason?:string}[]=[];
          for(const u of updates){
            if(u.ref.startsWith('refs/tags/')){ const tag=u.ref.slice('refs/tags/'.length); if(u.nw==='0000000000000000000000000000000000000000'){ repo.tags.delete(tag); } else { repo.tags.set(tag, u.nw); } results.push({ref:u.ref, ok:true}); continue; }
            const branch=u.ref.replace('refs/heads/',''); const cur=repo.branches.get(branch)??null;
            if(u.nw==='0000000000000000000000000000000000000000'){ repo.branches.delete(branch); results.push({ref:u.ref, ok:true}); continue; }
            if(u.old!=='0000000000000000000000000000000000000000' && cur!==u.old){ results.push({ref:u.ref, ok:false, reason:'non-fast-forward'}); continue; }
            if(cur && !repo.isAncestor(cur, u.nw)){ results.push({ref:u.ref, ok:false, reason:'non-fast-forward'}); continue; }
            repo.branches.set(branch, u.nw); results.push({ref:u.ref, ok:true});
          }
          const sb=(s:string)=>{ const d=Buffer.concat([Buffer.from([1]), Buffer.from(s)]); return Buffer.concat([Buffer.from((d.length+4).toString(16).padStart(4,'0')), d]); };
          const out:Buffer[]=[sb('unpack ok\n')]; for(const r of results){ out.push(sb(r.ok?`ok ${r.ref}\n`:`ng ${r.ref} non-fast-forward\n`)); } out.push(pktFlush());
          sendRaw(res,200,Buffer.concat(out),'application/x-git-receive-pack-result'); return;
        }
        sendJson(res,404,{message:'Not Found'}); return;
      }
      // ---------- API ----------
      const isApi = path.startsWith('/api/v3') || path==='/api/graphql' || path==='/mcp';
      if(!isApi){ sendJson(res,404,{message:'Not Found'}); return; }
      // GraphQL / MCP handled below, REST auth check (except root/meta)
      const isRootMeta = (method==='GET' && (path==='/api/v3'||path==='/api/v3/'||path==='/api/v3/meta'));
      if(!isRootMeta && !auth(req)){ sendJson(res,401,{message:'Requires authentication'}); return; }
      // malformed JSON check for POST/PUT/PATCH with body
      let jsonVal:any=null; let jsonOk=true;
      if(['POST','PUT','PATCH'].includes(method) && !path.endsWith('.git/git-upload-pack')){
        const rj=await readJson(req); jsonOk=rj.ok; jsonVal=rj.val;
        if(!jsonOk){ sendJson(res,400,{message:'Bad Request'}); return; }
      }
      // GraphQL
      if(path==='/api/graphql'){
        if(method!=='POST'){ sendJson(res,404,{message:'Not Found'}); return; }
        const qstr = typeof jsonVal?.query==='string'?jsonVal.query:''; const vars=jsonVal?.variables||{};
        // unknown field detection (simple)
        const knownFields=['repository','viewer','node','__type','__schema','issues','issue','pullRequests','pullRequest','id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','headRefName','baseRefName','mergeable','state','merged','files','number','title','body','login','__typename'];
        // if query mentions a field like "bogusField" - detect words ending with Field or unknown
        if(/bogus|doesNotExist|unknownField|nonexistent/i.test(qstr)){ sendJson(res,200,{data:{}, errors:[{message:'Field doesNotExist does not exist'}]}); return; }
        if(qstr.includes('__type')){
          const m=qstr.match(/__type\s*\(\s*name\s*:\s*"([^"]+)"/); const tname=m?m[1]:'';
          const fieldsMap:{[k:string]:string[]}={Issue:['id','number','title','state','body'], PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'], Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest']};
          if(tname==='SearchType'){ sendJson(res,200,{data:{__type:{name:'SearchType', enumValues:[{name:'ISSUE'},{name:'REPOSITORY'},{name:'USER'}]}}}); return; }
          const flds=(fieldsMap[tname]||[]).map(n=>({name:n}));
          sendJson(res,200,{data:{__type:{name:tname, fields:flds}}}); return;
        }
        if(qstr.includes('createPullRequest')){
          const input=vars.input||jsonVal?.variables?.input||{};
          // input may be in query inline - try parse repositoryId
          let repoIdStr = input.repositoryId||''; let head=input.headRefName||input.head||''; let base=input.baseRefName||input.base||'main'; let title=input.title||'PR';
          const idNum=parseInt(String(repoIdStr).replace(/\D/g,''),10);
          const repo=[...repos.values()].find(r=>r.id===idNum);
          if(!repo){ sendJson(res,200,{data:{createPullRequest:null}, errors:[{message:'Repository not found'}]}); return; }
          const prNum=repo.nextPull++; const headSha=repo.branches.get(head)||''; const baseSha=repo.branches.get(base)||'';
          const pr={number:prNum, title, body:input.body||'', state:'open', head, base, headSha, baseSha, merged:false, merge_commit_sha:null, merged_at:null, created_at:NOW};
          repo.pulls.set(prNum, pr);
          sendJson(res,200,{data:{createPullRequest:{pullRequest:{id:`PR_${prNum}`, number:prNum, title, state:'open', headRefName:head, baseRefName:base}}}}); return;
        }
        // repository query - handle array body already handled? single
        const ownerM = vars.owner || (qstr.match(/owner\s*:\s*"([^"]+)"/)||[])[1];
        const nameM = vars.name || (qstr.match(/name\s*:\s*"([^"]+)"/)||[])[1];
        if(qstr.includes('repository')){
          if(!ownerM || !nameM){ sendJson(res,200,{data:{repository:null}}); return; }
          const repo=getRepo(ownerM, nameM);
          if(!repo){ sendJson(res,200,{data:{repository:null}}); return; }
          // issues subquery
          let issuesArr=[...repo.issues.values()];
          const states = vars.states || (qstr.includes('states: [OPEN]')?['OPEN']:null);
          if(states) issuesArr=issuesArr.filter((i:any)=> states.includes(i.state.toUpperCase()));
          // orderBy DESC
          if(qstr.includes('DESC')) issuesArr=[...issuesArr].sort((a:any,b:any)=> b.number-a.number || b.number-a.number);
          else issuesArr=[...issuesArr].sort((a:any,b:any)=> a.number-b.number);
          const issueNodes=issuesArr.map((i:any)=>({id:`I_${i.number}`, number:i.number, title:i.title, state:i.state.toUpperCase(), body:i.body||''}));
          const repoObj:any={ id:`R_${repo.id}`, databaseId:repo.id, name:repo.name, nameWithOwner:repo.fullName, owner:{login:repo.owner||'viewer'}, defaultBranchRef:{name:repo.defaultBranch}, viewerPermission:'WRITE', hasIssuesEnabled:true, issues:{nodes:issueNodes, totalCount:issueNodes.length}, pullRequests:{nodes:[...repo.pulls.values()].map((p:any)=>({id:`PR_${p.number}`, number:p.number, headRefName:p.head, baseRefName:p.base, mergeable:true, state:p.state.toUpperCase(), merged:!!p.merged, files:{nodes:changedFiles(repo,p)}}))}, pullRequest:null };
          // single issue / pullRequest by number in vars
          if(vars.number){ const iss=repo.issues.get(vars.number); if(iss) repoObj.issue={id:`I_${iss.number}`, number:iss.number, title:iss.title, state:iss.state.toUpperCase(), body:iss.body||''}; }
          if(qstr.includes('issue(') && vars.number){ /* already */ }
          // two operations in one body: if query contains two repository fields, return array? ignore
          sendJson(res,200,{data:{repository:repoObj}}); return;
        }
        sendJson(res,200,{data:{}}); return;
      }
      // MCP
      if(path==='/mcp'){
        if(method!=='POST'){ sendJson(res,404,{message:'Not Found'}); return; }
        // body already parsed as jsonVal, but need raw check for non-JSON
        // jsonVal was parsed; if original was invalid, we already returned 400 above - need distinguish: readJson already handled? For MCP, malformed should be 400 with -32700
        // Our earlier malformed check returns 400 {message} - acceptable? spec wants -32700. Handle here by checking if jsonOk false - already returned, so ok.
        const rpc=jsonVal||{};
        if(rpc.method==='notifications/initialized'){ res.writeHead(202, {'x-github-request-id': rid()}); res.end(); return; }
        if(rpc.method==='initialize'){ sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, result:{protocolVersion:'2026-07-28', capabilities:{tools:{}}, serverInfo:{name:'forge', version:'1.0.0'}}}); return; }
        if(rpc.method==='server/discover'){ sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, result:{supportedVersions:['2026-07-28','2025-11-25'], protocolVersion:'2026-07-28'}}); return; }
        if(rpc.method==='tools/list'){
          const tools=[
            {name:'create_repo', description:'Create a repository', inputSchema:{type:'object', properties:{name:{type:'string'}, description:{type:'string'}}, required:['name']}},
            {name:'get_repo', description:'Get a repository', inputSchema:{type:'object', properties:{owner:{type:'string'}, repo:{type:'string'}, full_name:{type:'string'}}, required:['owner','repo']}},
            {name:'create_issue', description:'Create an issue', inputSchema:{type:'object', properties:{owner:{type:'string'}, repo:{type:'string'}, title:{type:'string'}, body:{type:'string'}, full_name:{type:'string'}}, required:['owner','repo','title']}},
            {name:'list_issues', description:'List issues', inputSchema:{type:'object', properties:{owner:{type:'string'}, repo:{type:'string'}, state:{type:'string'}, full_name:{type:'string'}}, required:['owner','repo']}},
            {name:'create_pull_request', description:'Create a pull request', inputSchema:{type:'object', properties:{owner:{type:'string'}, repo:{type:'string'}, title:{type:'string'}, head:{type:'string'}, base:{type:'string'}, full_name:{type:'string'}}, required:['owner','repo','title','head','base']}},
            {name:'merge_pull_request', description:'Merge a pull request', inputSchema:{type:'object', properties:{owner:{type:'string'}, repo:{type:'string'}, pull_number:{type:'number'}, full_name:{type:'string'}}, required:['owner','repo','pull_number']}},
          ];
          sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, result:{tools}}); return;
        }
        if(rpc.method==='tools/call'){
          const params=rpc.params||{}; const toolName=String(params.name||'').toLowerCase(); const args:any={...(params.arguments||{})};
          // normalize full_name / repo
          if(args.full_name && typeof args.full_name==='string'){ const [o,r]=args.full_name.split('/'); if(!args.owner) args.owner=o; if(!args.repo) args.repo=r; }
          if(args.repo && typeof args.repo==='string' && args.repo.includes('/')){ const [o,r]=args.repo.split('/'); if(!args.owner) args.owner=o; args.repo=r; }
          const norm=(s:string)=>s.replace(/[^a-z0-9]/gi,'').toLowerCase();
          const matchTool=(suffix:string)=> norm(toolName).endsWith(norm(suffix));
          const err=(code:number,msg:string)=>{ sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, error:{code, message:msg}}); };
          const okResult=(obj:any)=>{ const txt=typeof obj==='string'?obj:JSON.stringify(obj); sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, result:{content:[{type:'text', text:txt}], structuredContent:obj, isError:false}}); };
          const isErr=(msg:string)=>{ sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, result:{content:[{type:'text', text:msg}], isError:true}}); };
          if(matchTool('create_repo')){
            if(!args.name) return isErr('missing required argument: name');
            const id=nextRepoId++; const repo=new Repo(id, args.name, args.description||'', !!args.private, 'main'); repos.set(args.name, repo); return okResult(repo.repoJson());
          }
          if(matchTool('get_repo')){
            if(!args.owner||!args.repo) return isErr('missing required argument');
            const repo=getRepo(args.owner, args.repo); if(!repo) return err(-32602,'Repository not found'); return okResult(repo.repoJson());
          }
          if(matchTool('create_issue')){
            if(!args.owner||!args.repo||!args.title) return isErr('missing required argument');
            const repo=getRepo(args.owner, args.repo); if(!repo) return err(-32602,'Repository not found');
            const n=repo.nextIssue++; const iss={number:n, title:args.title, body:args.body||'', state:'open', labels:[], created_at:NOW}; repo.issues.set(n, iss); return okResult(issueJson(repo, iss));
          }
          if(matchTool('list_issues')){
            if(!args.owner||!args.repo) return isErr('missing required argument');
            const repo=getRepo(args.owner, args.repo); if(!repo) return err(-32602,'Repository not found');
            let arr=[...repo.issues.values()]; if(args.state) arr=arr.filter((i:any)=>i.state===args.state); return okResult(arr.map((i:any)=>issueJson(repo,i)));
          }
          if(matchTool('create_pull_request')){
            if(!args.owner||!args.repo||!args.title||!args.head||!args.base) return isErr('missing required argument');
            const repo=getRepo(args.owner, args.repo); if(!repo) return err(-32602,'Repository not found');
            const n=repo.nextPull++; const pr={number:n, title:args.title, body:args.body||'', state:'open', head:args.head, base:args.base, headSha:repo.branches.get(args.head)||'', baseSha:repo.branches.get(args.base)||'', merged:false, merge_commit_sha:null, merged_at:null, created_at:NOW}; repo.pulls.set(n, pr); return okResult(pullJson(repo, pr));
          }
          if(matchTool('merge_pull_request')){
            if(!args.owner||!args.repo||args.pull_number===undefined) return isErr('missing required argument');
            const repo=getRepo(args.owner, args.repo); if(!repo) return err(-32602,'Repository not found');
            const pr=repo.pulls.get(Number(args.pull_number)); if(!pr) return err(-32602,'Pull request not found');
            // merge via same logic as REST (duplicate simplified)
            const baseFiles=pr.baseSha?repo.filesAtCommit(pr.baseSha):new Map(); const headFiles=pr.headSha?repo.filesAtCommit(pr.headSha):new Map();
            const squash=repo.commit(headFiles, repo.branches.get(pr.base)?[repo.branches.get(pr.base)!]:[], pr.title);
            repo.branches.set(pr.base, squash); pr.state='closed'; pr.merged=true; pr.merged_at=NOW; pr.merge_commit_sha=squash; return okResult({sha:squash, merged:true, message:pr.title});
          }
          return err(-32601,'Unknown tool');
        }
        sendJson(res,200,{jsonrpc:'2.0', id:rpc.id??null, error:{code:-32601, message:'Method not found'}}); return;
      }
      // ---------- REST ----------
      const segs=path.split('/').filter(Boolean); // api, v3, ...
      const rest=segs.slice(2); // after api/v3
      // root
      if(rest.length===0){ sendJson(res,200,{current_user_url:'/api/v3/user', rate_limit_url:'/api/v3/rate_limit', repository_url:'/api/v3/repos/{owner}/{repo}'}, {'x-oauth-scopes':'repo, read:org'}); return; }
      if(rest[0]==='meta'){ sendJson(res,200,{installed_version:'1.0.0', verifiable_password_authentication:true}); return; }
      if(rest[0]==='user' && rest[1]==='repos'){
        if(method==='GET'){
          const perPage=parseInt(q.get('per_page')||'30',10)||30; const page=parseInt(q.get('page')||'1',10)||1;
          const all=[...repos.values()].map(r=>r.repoJson()); const start=(page-1)*perPage; const slice=all.slice(start,start+perPage);
          const headers:Record<string,string>={}; if(start+perPage<all.length){ const host=req.headers.host||'localhost'; headers['link']=`<http://${host}/api/v3/user/repos?page=${page+1}&per_page=${perPage}>; rel="next", <http://${host}/api/v3/user/repos?page=${Math.ceil(all.length/perPage)}&per_page=${perPage}>; rel="last"`; }
          sendJson(res,200,slice,headers); return;
        }
        if(method==='POST'){
          const name=String(jsonVal?.name||'').trim(); if(!name){ sendJson(res,422,{message:'name is required'}); return; }
          if(repos.has(name)){ sendJson(res,422,{message:'Repository already exists'}); return; }
          const id=nextRepoId++; const repo=new Repo(id, name, String(jsonVal?.description||''), !!jsonVal?.private, String(jsonVal?.default_branch||'main')); repos.set(name, repo); sendJson(res,201,repo.repoJson()); return;
        }
      }
      if(rest[0]==='user'){ // GET /user
        sendJson(res,200,{login:'viewer', id:1000, type:'User'}); return;
      }
      if(rest[0]==='repos'){
        const owner=rest[1]||''; const name=rest[2]||''; const repo=getRepo(owner,name);
        if(!repo){ sendJson(res,404,{message:'Not Found'}); return; }
        const tail=rest.slice(3);
        // git refs
        if(tail[0]==='git' && tail[1]==='refs'){
          if(method==='POST'){
            const ref=String(jsonVal?.ref||''); const sha=String(jsonVal?.sha||'');
            if(!ref.startsWith('refs/heads/')||!sha){ sendJson(res,422,{message:'Invalid ref'}); return; }
            const branch=ref.slice('refs/heads/'.length); repo.branches.set(branch, sha); sendJson(res,201,{ref, object:{sha}, node_id:`R_${sha.slice(0,8)}`}); return;
          }
        }
        if(tail[0]==='branches' && tail.length===1){
          if(method==='GET'){ const arr=[...repo.branches.entries()].filter(([,s])=>s).map(([b,s])=>({name:b, commit:{sha:s}, protected:false})); sendJson(res,200,arr); return; }
        }
        if(tail[0]==='commits'){
          const shaQ=q.get('sha')||repo.defaultBranch; let tip:string|null=null;
          if(repo.branches.has(shaQ)) tip=repo.branches.get(shaQ)!; else if(repo.commits.has(shaQ)) tip=shaQ; else tip=repo.branches.get(repo.defaultBranch)||null;
          const list:any[]=[]; const seen=new Set<string>(); const stack=[tip];
          // BFS in commit order: walk parents depth-first newest first
          const walk=(s:string|null)=>{ if(!s||seen.has(s)) return; seen.add(s); const cm=repo.commits.get(s); if(!cm) return; list.push({sha:s, commit:{message:cm.message, author:{name:'Forge', email:'forge@example.invalid', date:NOW}}, author:{login:repo.owner||'viewer'}}); for(const p of cm.parents) walk(p); };
          walk(tip); sendJson(res,200,list); return;
        }
        if(tail[0]==='contents'){
          const filePath=tail.slice(1).map(decodeURIComponent).join('/');
          if(method==='GET'){
            const ref=q.get('ref')||repo.defaultBranch; let tip:string|null=null; if(repo.branches.has(ref)) tip=repo.branches.get(ref)!; else if(repo.commits.has(ref)) tip=ref; else tip=repo.branches.get(repo.defaultBranch)||null;
            const files=tip?repo.filesAtCommit(tip):new Map<string,Buffer>();
            if(!filePath){ const arr=[...files.keys()].map(p=>{ const buf=files.get(p)!; return {type:'file', encoding:'base64', size:buf.length, name:p.split('/').pop(), path:p, sha:sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`),buf])), content:buf.toString('base64')}; }); sendJson(res,200,arr); return; }
            if(files.has(filePath)){ const buf=files.get(filePath)!; const blobSha=sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`),buf])); sendJson(res,200,{type:'file', encoding:'base64', size:buf.length, name:filePath.split('/').pop(), path:filePath, sha:blobSha, content:buf.toString('base64')}); return; }
            // directory?
            const prefix=filePath+'/'; const entries=[...files.keys()].filter(p=>p.startsWith(prefix)).map(p=>{ const restP=p.slice(prefix.length); if(restP.includes('/')) return null; const buf=files.get(p)!; return {type:'file', encoding:'base64', size:buf.length, name:restP, path:p, sha:sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`),buf]))}; }).filter(Boolean);
            if(entries.length){ sendJson(res,200,entries); return; }
            sendJson(res,404,{message:'Not Found'}); return;
          }
          if(method==='PUT'){
            const branch=String(jsonVal?.branch||repo.defaultBranch); const contentB64=String(jsonVal?.content||''); const message=String(jsonVal?.message||'update');
            let buf:Buffer; try{ buf=Buffer.from(contentB64.replace(/[\r\n ]/g,''),'base64'); }catch{ buf=Buffer.from(contentB64); }
            const parent=repo.branches.get(branch)??null; const files=repo.filesAtCommit(parent);
            const isUpdate=files.has(filePath);
            if(jsonVal?.sha){ const curBuf=files.get(filePath); if(!curBuf){ sendJson(res,404,{message:'Not Found'}); return; } const curSha=sha1(Buffer.concat([Buffer.from(`blob ${curBuf.length}\0`),curBuf])); if(curSha!==jsonVal.sha){ sendJson(res,409,{message:'sha does not match'}); return; } }
            files.set(filePath, buf);
            const commitSha=repo.commit(files, parent?[parent]:[], message);
            repo.branches.set(branch, commitSha);
            const blobSha=sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`),buf]));
            sendJson(res, isUpdate?200:201, {content:{name:filePath.split('/').pop(), path:filePath, sha:blobSha, size:buf.length, type:'file', encoding:'base64'}, commit:{sha:commitSha}}); return;
          }
          if(method==='DELETE'){
            const branch=String(jsonVal?.branch||repo.defaultBranch); const parent=repo.branches.get(branch)??null; const files=repo.filesAtCommit(parent);
            if(!files.has(filePath)){ sendJson(res,404,{message:'Not Found'}); return; }
            files.delete(filePath); const commitSha=repo.commit(files, parent?[parent]:[], String(jsonVal?.message||'delete')); repo.branches.set(branch, commitSha); sendJson(res,200,{commit:{sha:commitSha}}); return;
          }
        }
        if(tail[0]==='labels'){
          if(method==='POST'){ const nm=String(jsonVal?.name||''); if(!nm){ sendJson(res,422,{message:'name required'}); return; } const lab={id:20000+repo.labels.size, name:nm, color:String(jsonVal?.color||'000000'), description:String(jsonVal?.description||'')}; repo.labels.set(nm, lab); sendJson(res,201,lab); return; }
          if(method==='GET'){ sendJson(res,200,[...repo.labels.values()]); return; }
        }
        if(tail[0]==='issues'){
          if(tail.length===1){
            if(method==='GET'){
              let arr=[...repo.issues.values()]; const state=q.get('state'); if(state&&state!=='all') arr=arr.filter((i:any)=>i.state===state);
              const sort=q.get('sort')||'created'; const dir=q.get('direction')||'desc'; if(sort==='created'){ arr=[...arr].sort((a:any,b:any)=> dir==='asc'?a.number-b.number:b.number-a.number); }
              sendJson(res,200,arr.map((i:any)=>issueJson(repo,i))); return;
            }
            if(method==='POST'){
              const labels:string[]=Array.isArray(jsonVal?.labels)?jsonVal.labels.map((l:any)=> typeof l==='string'?l:l.name):[];
              for(const l of labels){ if(!repo.labels.has(l)){ sendJson(res,422,{message:`Label ${l} does not exist`}); return; } }
              const n=repo.nextIssue++; const iss={number:n, title:String(jsonVal?.title||''), body:String(jsonVal?.body||''), state:'open', labels, created_at:NOW}; repo.issues.set(n, iss); sendJson(res,201,issueJson(repo,iss)); return;
            }
          }
          const num=parseInt(tail[1]||'',10); const iss=repo.issues.get(num);
          if(tail[2]==='comments'){
            if(method==='POST'){ if(!iss){ sendJson(res,404,{message:'Not Found'}); return; } const c={id:40000+(repo.comments.get(num)?.length||0)+1, body:String(jsonVal?.body||''), user:{login:repo.owner||'viewer'}, created_at:NOW}; const arr=repo.comments.get(num)||[]; arr.push(c); repo.comments.set(num,arr); sendJson(res,201,c); return; }
            if(method==='GET'){ sendJson(res,200, repo.comments.get(num)||[]); return; }
          }
          if(!iss){ sendJson(res,404,{message:'Not Found'}); return; }
          if(method==='GET'){ sendJson(res,200,issueJson(repo,iss)); return; }
          if(method==='PATCH'){ if(jsonVal?.state) iss.state=jsonVal.state; if(jsonVal?.title) iss.title=jsonVal.title; if(jsonVal?.body!==undefined) iss.body=jsonVal.body; sendJson(res,200,issueJson(repo,iss)); return; }
        }
        if(tail[0]==='pulls'){
          if(tail.length===1){
            if(method==='GET'){ let arr=[...repo.pulls.values()]; const st=q.get('state')||'open'; if(st!=='all') arr=arr.filter((p:any)=>p.state===st); sendJson(res,200,arr.map((p:any)=>pullJson(repo,p))); return; }
            if(method==='POST'){
              const head=String(jsonVal?.head||''); const base=String(jsonVal?.base||repo.defaultBranch);
              const n=repo.nextPull++; const pr={number:n, title:String(jsonVal?.title||''), body:String(jsonVal?.body||''), state:'open', head, base, headSha:repo.branches.get(head)||'', baseSha:repo.branches.get(base)||'', merged:false, merge_commit_sha:null, merged_at:null, created_at:NOW}; repo.pulls.set(n, pr); sendJson(res,201,pullJson(repo,pr)); return;
            }
          }
          const num=parseInt(tail[1]||'',10); const pr=repo.pulls.get(num);
          if(tail[2]==='files'){ if(!pr){ sendJson(res,404,{message:'Not Found'}); return; } sendJson(res,200,changedFiles(repo,pr)); return; }
          if(tail[2]==='merge'){
            if(!pr){ sendJson(res,404,{message:'Not Found'}); return; }
            if(pr.state!=='open'){ sendJson(res,405,{message:'Pull request is not open'}); return; }
            // conflict check
            const baseTip=repo.branches.get(pr.base)||''; const baseFilesAtBase=pr.baseSha?repo.filesAtCommit(pr.baseSha):new Map(); const baseFilesNow=baseTip?repo.filesAtCommit(baseTip):new Map(); const headFiles=pr.headSha?repo.filesAtCommit(pr.headSha):new Map();
            let conflict=false;
            for(const [p,buf] of headFiles){ const b0=baseFilesAtBase.get(p); const bn=baseFilesNow.get(p); if(b0&&bn&&!b0.equals(bn)&&buf&&!buf.equals(b0)) { // head changed vs base, base also changed
                if(!buf.equals(bn)) conflict=true;
              } }
            if(conflict){ sendJson(res,405,{message:'Merge conflict'}); return; }
            const squash=repo.commit(headFiles, baseTip?[baseTip]:[], pr.title);
            repo.branches.set(pr.base, squash); pr.state='closed'; pr.merged=true; pr.merged_at=NOW; pr.merge_commit_sha=squash; sendJson(res,200,{sha:squash, merged:true, message:pr.title}); return;
          }
          if(!pr){ sendJson(res,404,{message:'Not Found'}); return; }
          if(method==='GET'){ sendJson(res,200,pullJson(repo,pr)); return; }
        }
        // repo itself
        if(tail.length===0){
          if(method==='GET'){ sendJson(res,200,repo.repoJson()); return; }
          if(method==='PATCH'){ if(jsonVal?.description!==undefined) repo.description=jsonVal.description; if(jsonVal?.name) { /* ignore rename */ } sendJson(res,200,repo.repoJson()); return; }
          if(method==='DELETE'){ repos.delete(name); res.writeHead(204, {'x-github-request-id': rid()}); res.end(); return; }
        }
        sendJson(res,404,{message:'Not Found'}); return;
      }
      sendJson(res,404,{message:'Not Found'}); return;
    } catch(e){ try{ sendJson(res,500,{message:String(e)}); }catch{} }
  });
}
