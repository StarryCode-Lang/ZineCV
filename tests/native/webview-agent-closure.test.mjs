import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const directory = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-agent-closure");
const invoke = (page, name, args = {}) => page.evaluate(({name,args}) => window.__TAURI_INTERNALS__.invoke(name,args), {name,args});

test("Windows actual Agent stop discards delayed output; model and tool budgets terminate without modifying a document", { timeout: 240_000 }, async () => {
  await mkdir(directory, {recursive:true});
  const profile = await mkdtemp(join(directory, "profile-"));
  const report = {passed:false, scope:"Real Windows UI + gateway to owned local synthetic SSE service; no real-model qualification", checks:[]};
  let mode = "hold", held, calls = 0, closedAfterStop = false, host;
  const server = createServer(async (request,response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    if (payload.tools?.some(({function: fn}) => fn.name === "zinecv_capability_probe")) {
      const nonce = payload.tools[0].function.parameters.properties.nonce.enum[0];
      response.writeHead(200,{"Content-Type":"application/json"});
      response.end(JSON.stringify({choices:[{finish_reason:"tool_calls",message:{tool_calls:[{id:"closure-probe",type:"function",function:{name:"zinecv_capability_probe",arguments:JSON.stringify({nonce})}}]}}]}));
      return;
    }
    response.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8"});
    if (!payload.tools?.length) { response.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'); return; }
    calls++;
    if (mode === "hold") {
      response.write('data: {"choices":[{"delta":{"content":"取消竞争测试已开始"}}]}\n\n');
      held = response;
      response.once("close", () => { closedAfterStop = true; });
    } else if (mode === "reply") {
      response.end('data: {"choices":[{"delta":{"content":"新的运行正常完成"}}]}\n\ndata: [DONE]\n\n');
    } else {
      const count = mode === "tools" ? 4 : 1;
      const tool_calls = Array.from({length:count},(_,index) => ({index,id:"closure-"+calls+"-"+index,type:"function",function:{name:"local_help",arguments:"{}"}}));
      response.end("data: "+JSON.stringify({choices:[{delta:{tool_calls}}]})+"\n\ndata: [DONE]\n\n");
    }
  });
  await new Promise((done,reject) => server.once("error",reject).listen(0,"127.0.0.1",done));
  try {
    host = await startNativeHost(profile);
    const page = host.page;
    await page.getByRole("button",{name:"展开基本信息",exact:true}).click();
    await page.getByLabel("姓名",{exact:true}).fill("取消保护测试");
    await page.getByLabel("姓名",{exact:true}).press("Tab");
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === "取消保护测试");
    if (await page.getByRole("button",{name:"模型设置"}).count() === 0) await page.getByRole("button",{name:"展开 Re:me 助手"}).click();
    if (await page.getByRole("button",{name:"展开聊天"}).count()) await page.getByRole("button",{name:"展开聊天"}).click();
    const localComposer = page.getByLabel("给 Re:me 助手发送消息");
    const localBaseline = await invoke(page,"document_state");
    for (const [command,pattern] of [["/help",/本地命令：/]]) {
      await localComposer.fill(command); await page.getByRole("button",{name:"发送消息"}).click();
      await page.getByText(pattern).waitFor();
    }
    await localComposer.fill("/");
    await page.getByRole("listbox",{name:"选择技能"}).getByRole("option",{name:/检查内容/}).first().click();
    await localComposer.fill("检查选中内容"); await page.getByRole("button",{name:"发送消息"}).click();
    await page.getByText(/需要先用 @ 明确选择处理范围/).waitFor();
    await localComposer.fill("/sessions"); await page.getByRole("button",{name:"发送消息"}).click();
    await page.getByLabel("历史对话列表").waitFor();
    await page.getByRole("button",{name:"历史对话",exact:true}).click();
    await localComposer.fill("/new"); await page.getByRole("button",{name:"发送消息"}).click();
    assert.equal(calls,0); assert.deepEqual(await invoke(page,"document_state"),localBaseline);
    report.checks.push({mode:"anonymous-local-skills",commands:["help","check","sessions","new","settings"],modelCalls:0,documentUnchanged:true});
    await localComposer.fill("/settings"); await page.getByRole("button",{name:"发送消息"}).click();
    const settings = page.getByRole("dialog",{name:"模型连接"});
    await settings.getByLabel("邮箱",{exact:true}).fill("closure@example.invalid");
    await settings.getByLabel("密码",{exact:true}).fill("owned-closure-password");
    await settings.getByRole("button",{name:"注册并登录"}).click();
    await settings.getByText("已登录：closure@example.invalid").waitFor();
    await settings.getByLabel("连接名称",{exact:true}).fill("本地合成验收");
    await settings.getByLabel("Base URL",{exact:true}).fill("http://127.0.0.1:"+server.address().port+"/v1");
    await settings.getByLabel("API Key",{exact:true}).fill("owned-synthetic-secret");
    await settings.getByLabel("模型 ID",{exact:true}).fill("owned-model");
    await settings.getByRole("button",{name:"保存连接"}).click();
    await settings.getByText(/连接已加密保存到此账户/).waitFor();
    await settings.getByRole("button",{name:"测试连接"}).click();
    await settings.getByText(/结构化工具通过/).waitFor();
    await settings.getByRole("button",{name:"关闭模型设置"}).click();
    if (await page.getByRole("button",{name:"展开聊天"}).count()) await page.getByRole("button",{name:"展开聊天"}).click();
    const composer = page.getByLabel("给 Re:me 助手发送消息");
    const send = async text => {
      await composer.fill(text+" "); await composer.pressSequentially("@姓名");
      await page.getByRole("listbox",{name:"选择引用"}).getByRole("option",{name:/姓名/}).click();
      await page.getByRole("button",{name:"发送消息"}).click();
    };
    const baseline = await invoke(page,"document_state");
    await send("停止正在运行的请求");
    await page.getByRole("button",{name:"停止请求"}).waitFor();
    await page.getByText("取消竞争测试已开始",{exact:false}).waitFor();
    const running = (await invoke(page,"list_agent_runs")).find(run => run.lifecycleState === "running");
    assert.ok(running); assert.ok(held);
    await page.getByRole("button",{name:"停止请求"}).click();
    await page.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke("list_agent_runs")).find(run=>run.id===id)?.lifecycleState !== "running",running.id);
    // An attempted late server chunk cannot become a proposal or a document write.
    if (!held.destroyed && !held.writableEnded) held.end('data: {"choices":[{"delta":{"content":"不允许应用的迟到结果"}}]}\n\ndata: [DONE]\n\n');
    assert.deepEqual(await invoke(page,"document_state"),baseline);
    const cancelled = (await invoke(page,"list_agent_runs")).find(run=>run.id===running.id);
    assert.equal(cancelled.lifecycleState,"cancelled");
    report.checks.push({mode:"cancel",runId:running.id,lifecycleState:cancelled.lifecycleState,closedAfterStop,documentUnchanged:true});
    mode = "reply"; calls = 0;
    await send("停止后继续正常请求");
    await page.getByText("新的运行正常完成",{exact:false}).waitFor();
    await page.getByRole("button",{name:"停止请求"}).waitFor({state:"detached"});
    assert.deepEqual(await invoke(page,"document_state"),baseline);
    report.checks.push({mode:"after-cancel",modelCalls:calls,documentUnchanged:true});
    for (const [nextMode,expectedCalls,pattern] of [["models",6,/6 次模型调用上限/],["tools",4,/12 次工具调用上限/]]) {
      mode = nextMode; calls = 0;
      await send("验证"+nextMode+"预算");
      await page.getByText(pattern).waitFor({timeout:90_000});
      await page.getByRole("button",{name:"停止请求"}).waitFor({state:"detached"});
      assert.equal(calls,expectedCalls);
      assert.deepEqual(await invoke(page,"document_state"),baseline);
      report.checks.push({mode:nextMode,modelCalls:calls,documentUnchanged:true});
    }
    const runs = await invoke(page,"list_agent_runs");
    assert.ok(runs.every(run=>run.lifecycleState !== "running"));
    report.runs = runs.map(({id,lifecycleState,target})=>({id,lifecycleState,target}));
    await page.screenshot({path:join(directory,"budget-terminated.png"),animations:"disabled"});
    report.passed = true;
  } catch(error) { report.error=String(error.stack); if(host) report.visibleText=await host.page.locator("body").innerText().catch(()=>""); throw error; }
  finally {
    if(held && !held.writableEnded) held.end("data: [DONE]\n\n");
    if(host) await stopNativeHost(host);
    server.closeAllConnections(); await new Promise(done=>server.close(done));
    await writeFile(join(directory,"agent-closure.json"),JSON.stringify(report,null,2));
    if(report.passed) await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});
  }
});
