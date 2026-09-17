const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
(async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'gps-links-test-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:process.env.PICKER_TEST_DIR || path.join(__dirname,'../location-picker'),env:{...process.env,PORT:String(port),TOKEN:'test-user-original',ADMIN_TOKEN:'test-admin-secret-long',DATA_FILE:path.join(data,'loc.json')},stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 async function request(route,body,method='GET',admin=false){
  return new Promise((resolve,reject)=>{
   const req=require('node:http').request(base+route,{method,headers:{'Host':'gps.example.test:38467','X-Forwarded-Proto':'https',...(admin?{'X-Admin-Token':'test-admin-secret-long'}:{}),...(body?{'Content-Type':'application/json'}:{})}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode,ok:res.statusCode===200,headers:{get:k=>res.headers[k]},text:async()=>text,json:async()=>JSON.parse(text)}));
   });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
 }
 try{
 let ready=false;for(let i=0;i<60;i++){try{if((await request('/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready);
 const created=[];for(const label of ['Alice','Bob']){let r=await request('/admin/api/tokens',{label},'POST',true);assert.equal(r.status,200);created.push(await r.json());}
 for(const user of created){
  assert(user.shadowrocketUrl.startsWith('https://gps.example.test:38467/modules/'), user.shadowrocketUrl);
  assert(user.quantumultXUrl.endsWith('token='+user.token));
  for(const file of ['shadowrocket.sgmodule','quantumult-x.snippet','quantumult-x.js']){
   assert.equal((await request('/modules/'+file)).status,401);
   assert.equal((await request('/modules/'+file+'?token=wrong')).status,403);
   assert.equal((await request('/modules/'+file+'?token=test-admin-secret-long')).status,403);
   const r=await request('/modules/'+file+'?token='+user.token);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
   const text=await r.text();assert(text.includes(user.token));assert(!text.includes(created.find(u=>u!==user).token));assert(!text.includes('test-admin-secret-long'));assert(!text.includes('__LOCATION_CONFIG_URL__'));
   if(file.endsWith('.js'))new vm.Script(text);
   if(file.endsWith('.snippet'))assert(text.includes('/modules/quantumult-x.js?token='+user.token));
  }
 }
 const users=await (await request('/admin/api/tokens',null,'GET',true)).json();assert(users.tokens.every(t=>t.shadowrocketUrl&&t.quantumultXUrl));assert(users.tokens.some(t=>t.token==='test-user-original'));
 const alice=created[0];await request('/admin/api/tokens/'+alice.id,{status:'disabled'},'POST',true);
 assert.equal((await request('/modules/quantumult-x.js?token='+alice.token)).status,403);
 assert.equal((await (await request('/loc.json?token='+alice.token)).json()).enabled,false);
 const bob=created[1];const script=await (await request('/modules/quantumult-x.js?token='+bob.token)).text();
 const upstream=require('../location-spoofer-qx.js');const payload=new Uint8Array([18,8,18,6,8,0,16,0,24,39]);
 async function run(remote,fail){let count=0;let output;await new Promise(resolve=>vm.runInNewContext(script,{$response:{bodyBytes:payload.buffer},$task:{fetch:async o=>{assert.equal(o.url,'https://gps.example.test:38467/loc.json?token='+bob.token);if(fail)throw Error('offline');return remote;}},$done:r=>{count++;output=r;resolve()},console:{log(){}},Uint8Array,ArrayBuffer}));assert.equal(count,1);return output;}
 for(const [r,fail] of [[{statusCode:200,body:'{"enabled":false}'}],[{statusCode:403,body:'{}'}],[{statusCode:200,body:'bad'}],[{statusCode:200,body:'{"enabled":true}'}],[{statusCode:200,body:'{"enabled":true,"latitude":91,"longitude":0}'}],[null,true]])assert.equal(Object.keys(await run(r,fail)).length,0);
 const cfg={...upstream.DEFAULT_CONFIG,enabled:true,latitude:31.23,longitude:121.47};const got=await run({statusCode:200,body:JSON.stringify(cfg)});assert.deepEqual(Buffer.from(got.bodyBytes),Buffer.from(upstream.spoofAppleResponse(payload,cfg).response));
 await request('/admin/api/tokens/'+bob.id,null,'DELETE',true);assert.equal((await request('/modules/shadowrocket.sgmodule?token='+bob.token)).status,403);
 const page=await (await request('/admin?token=test-admin-secret-long')).text();assert(page.includes('复制小火箭链接'));assert(page.includes('复制圈 X 链接'));assert(page.includes('复制选点链接'));new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
 console.log('PASS: new/existing users; per-user SR/QX URLs and scripts; auth; disabled/deleted tokens; QX remote binary rewrite/fail-open; admin browser script');
 }finally{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
