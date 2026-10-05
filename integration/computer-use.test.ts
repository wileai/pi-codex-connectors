import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AppApprovals } from "../src/computer-permissions.ts";
import { ComputerBridge } from "../src/computer-bridge.ts";

test("app approvals respect session, persistence, policy restrictions, denial and revocation", async () => {
 const dir=mkdtempSync(join(tmpdir(),"computer-approvals-"));
 const path=join(dir,"approvals.json");
 let calls=0, choice="Yes, for this session";
 const ctx={hasUI:true,ui:{select:async()=>{calls++;return choice;}}} as unknown as ExtensionContext;
 const request={message:"Synthetic app",_meta:{connector_id:"computer-use",persist:["session","always"],tool_params:{app:"test.synthetic"}}};
 const signal=new AbortController().signal;
 try {
  let approvals=new AppApprovals(path);
  assert.equal((await approvals.confirm(ctx,request,signal)).action,"accept");
  await approvals.confirm(ctx,request,signal);assert.equal(calls,1);
  approvals.clearSession();choice="No";
  assert.equal((await approvals.confirm(ctx,request,signal)).action,"decline");
  choice="Yes, forever";await approvals.confirm(ctx,request,signal);
  assert.equal(statSync(path).mode & 0o777,0o600);
  const before=calls;approvals=new AppApprovals(path);
  assert.equal((await approvals.confirm(undefined,request,signal)).action,"accept");assert.equal(calls,before);
  choice="No";await approvals.confirm(ctx,{...request,_meta:{...request._meta,persist:["session"]}},signal);assert.equal(calls,before+1);
  assert.equal((await approvals.confirm(undefined,{...request,_meta:{...request._meta,tool_params:{app:"other.app"}}},signal)).action,"decline");
  approvals.forget();assert.equal((await approvals.confirm(undefined,request,signal)).action,"decline");
  assert.equal((await approvals.confirm(ctx,{...request,requestedSchema:{properties:{password:{}}}},signal)).action,"decline");
  const abort=new AbortController();abort.abort();assert.equal((await approvals.confirm(ctx,request,abort.signal)).action,"decline");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("MCP bridge advertises elicitation and returns explicit approval or denial", async () => {
 const server=`const rl=require('node:readline').createInterface({input:process.stdin});let call;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));rl.on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')send({id:x.id,result:{form:!!x.params.capabilities.elicitation.form}});if(x.method==='tools/call'){call=x.id;send({id:'approval',method:'elicitation/create',params:{message:'Synthetic only'}});}if(x.id==='approval')send({id:call,result:x.result});});`;
 for(const action of ["accept","decline","cancel"] as const){
  let prompts=0;
  const bridge=await ComputerBridge.start(process.execPath,["-e",server],process.env,async()=>{prompts++;return {action};});
  try {const result=await bridge.request("tools/call",{});assert.equal(result.action,action);assert.equal(prompts,1);} finally {await bridge.close();}
 }
});
