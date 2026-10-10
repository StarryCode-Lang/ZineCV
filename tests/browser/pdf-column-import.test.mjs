import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {syntheticTwoColumnPdf} from "./fixtures/synthetic-two-column-pdf.mjs";
import {createBrowserTestServer,listenForBrowserTestServer,launchBrowserTestChromium} from "./fixtures/browser-test-server.mjs";
const root=resolve(import.meta.dirname,"../.."),directory=resolve(root,".artifacts/remaining/closure-optimization-20261008/pdf-columns");
test("real local PDF worker preserves short two-column paragraphs without ToUnicode",{timeout:90_000},async()=>{
 const server=await createBrowserTestServer(root);await listenForBrowserTestServer(server);const browser=await launchBrowserTestChromium({headless:true});const report={passed:false};try{
  const page=await browser.newPage();const origin="http://127.0.0.1:"+server.httpServer.address().port;const external=[];
  page.on("request",request=>{if(!request.url().startsWith(origin)&&!request.url().startsWith("data:")&&!request.url().startsWith("blob:"))external.push(request.url());});
  await page.goto(origin+"/__zinecv_browser_test_page.html");
  const result=await page.evaluate(async encoded=>{
   const {recognizeTemplate}=await import("/src/ui/services/template-import.ts");
   const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
   return recognizeTemplate(new File([bytes],"owned-two-column.pdf",{type:"application/pdf"}));
  },syntheticTwoColumnPdf().toString("base64"));
  const expected=["OWNED TWO COLUMN READING ORDER FIXTURE","Education","Example University","Bachelor 2020 to 2024","LEFT COLUMN END","Skills","Python","JavaScript","RIGHT COLUMN END"];
  let last=-1;for(const text of expected){const position=result.extractedText.indexOf(text);assert.ok(position>last,"reading order: "+text);last=position;}
  assert.deepEqual(external,[]);assert.match(result.previewDataUrl,/^data:image\/png;base64,/);
  report.extractedText=result.extractedText;report.warnings=result.recognitionWarnings;report.noExternalRequests=true;report.passed=true;
 }catch(error){report.error=String(error.stack);throw error;}finally{await browser.close();await server.close();await mkdir(directory,{recursive:true});await writeFile(resolve(directory,"columns.json"),JSON.stringify(report,null,2));}
});

