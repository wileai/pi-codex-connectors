import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Elicitation, ElicitationReply } from "./computer-bridge.ts";
export class AppApprovals {
 private session = new Set<string>();
 constructor(privateFile: string) { this.file = privateFile; }
 private file: string;
 clearSession() { this.session.clear(); }
 forget() { this.clearSession(); rmSync(this.file, {force:true}); }
 private saved(): string[] { try { const x=JSON.parse(readFileSync(this.file,"utf8"));return Array.isArray(x)?x.filter(v=>typeof v==="string"):[]; } catch { return []; } }
 async confirm(ctx: ExtensionContext | undefined, request: Elicitation, signal: AbortSignal): Promise<ElicitationReply> {
  if(signal.aborted || (request.mode && request.mode!=="form") || Object.keys(request.requestedSchema?.properties??{}).length) return {action:"decline"};
  const meta=request._meta??{};
  const app=(meta.tool_params as any)?.app;
  const persist=Array.isArray(meta.persist)?meta.persist:[];
  const key=meta.connector_id==="computer-use" && typeof app==="string" && app ? app : undefined;
  const canSession=!!key && persist.includes("session");
  const canAlways=canSession && persist.includes("always");
  if(canSession && this.session.has(key!)) return {action:"accept",content:{source:"computer-use-persisted-state"}};
  if(canAlways && this.saved().includes(key!)) return {action:"accept",content:{source:"computer-use-persisted-state"}};
  if(!ctx?.hasUI) return {action:"decline"};
  const options=[canSession?"Yes, for this session":"Yes, this request",...(canAlways?["Yes, forever"]:[]),"No"];
  const choice=await ctx.ui.select("Computer Use approval: " + request.message + (typeof meta.subtitle==="string"?"\n"+meta.subtitle:""),options,{signal});
  if(signal.aborted) return {action:"cancel"};
  if(choice===options[0]) { if(canSession)this.session.add(key!);return {action:"accept",content:{}}; }
  if(canAlways && choice==="Yes, forever") {
   mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
   const tmp=this.file+"."+randomUUID()+".tmp";
   try { writeFileSync(tmp,JSON.stringify([...new Set([...this.saved(),key!])]),{mode:0o600,flag:"wx"});renameSync(tmp,this.file); }
   catch { throw new Error("Could not save Computer Use approval in your Pi user directory."); }
   finally { rmSync(tmp,{force:true}); }
   return {action:"accept",content:{},_meta:{persist:"always"}} as ElicitationReply;
  }
  return {action:"decline"};
 }
}
