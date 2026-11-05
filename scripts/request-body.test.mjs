import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/request-body.ts", import.meta.url), "utf8");
const scope = { exports:{}, Uint8Array, Response };
new Script(ts.transpileModule(source, { compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } }).outputText).runInNewContext(scope);
const { readRequestBytes, readRequestForm } = scope.exports;
const budgetError = new Error("synthetic budget");
const tooLarge = () => budgetError;
function streamed(chunks, headers = {}) {
  let pulls=0, cancelled=false;
  const body=new ReadableStream({pull(controller){pulls++; if(chunks.length)controller.enqueue(chunks.shift());else controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
  const request=new Request("http://localhost/synthetic",{method:"POST",body,duplex:"half",headers});
  return {request,get pulls(){return pulls;},get cancelled(){return cancelled;}};
}
test("byte reader accepts empty and exact budgets",async()=>{
  assert.equal((await readRequestBytes(new Request("http://localhost/"),4,tooLarge)).length,0);
  const f=streamed([new Uint8Array([1,2]),new Uint8Array([3,4])]);
  assert.deepEqual([...await readRequestBytes(f.request,4,tooLarge)],[1,2,3,4]);
});
test("byte reader stops on overflow without relying on declared length",async()=>{
  for(const headers of [{},{"content-length":"1"}]){
    const f=streamed([new Uint8Array([1,2,3]),new Uint8Array([4,5,6]),new Uint8Array([7])],headers);
    await assert.rejects(readRequestBytes(f.request,4,tooLarge),error=>error===budgetError);
    assert.equal(f.pulls,2); assert.equal(f.cancelled,true);
  }
});
test("byte reader rejects declared overflow before reading",async()=>{
  const f=streamed([new Uint8Array([1])],{"content-length":"9"});
  await assert.rejects(readRequestBytes(f.request,4,tooLarge),error=>error===budgetError);
  assert.equal(f.pulls,0); assert.equal(f.cancelled,true);
});
test("byte reader preserves split multibyte text and counts bytes",async()=>{
  const bytes=new TextEncoder().encode("合成");
  const f=streamed([bytes.slice(0,2),bytes.slice(2)]);
  assert.equal(new TextDecoder().decode(await readRequestBytes(f.request,6,tooLarge)),"合成");
  await assert.rejects(readRequestBytes(streamed([bytes]).request,5,tooLarge),error=>error===budgetError);
});
test("multipart parsing retains fields and file bytes after bounded reading",async()=>{
  const form=new FormData(); form.set("body","合成消息");form.set("images",new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),"synthetic.png");
  const request=new Request("http://localhost/",{method:"POST",body:form});
  const parsed=await readRequestForm(request,4096,tooLarge);
  assert.equal(parsed.get("body"),"合成消息"); assert.equal(parsed.get("images").type,"image/png");
  assert.deepEqual([...new Uint8Array(await parsed.get("images").arrayBuffer())],[1,2,3]);
});
test("multipart budget failure is reported before form parsing",async()=>{
  const f=streamed([new Uint8Array(6)],{"content-type":"multipart/form-data; boundary=synthetic"});
  await assert.rejects(readRequestForm(f.request,4,tooLarge),error=>error===budgetError);
  assert.equal(f.cancelled,true);
});
