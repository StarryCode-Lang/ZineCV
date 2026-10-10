import {test} from "node:test";
import assert from "node:assert/strict";
import {pdfLines} from "../../src/ui/services/pdf-reading-order.ts";
const line=(text,x,y,width=100)=>({text,x,y,width,fontSize:12});

test("short two-column PDF reads a whole left column before the right, including rows above the old 70% cutoff",()=>{
 const input=[line("Header",50,740,420),...Array.from({length:4},(_,index)=>[line("LEFT "+index,50,680-index*24),line("RIGHT "+index,320,680-index*24)]).flat()];
 assert.deepEqual(pdfLines(input,2,612).map(line=>line.text),["Header","LEFT 0","LEFT 1","LEFT 2","LEFT 3","RIGHT 0","RIGHT 1","RIGHT 2","RIGHT 3"]);
 assert.ok(pdfLines(input,2,612).every(line=>line.page===2));
});
test("full-width headings reset column order without duplicating or dropping text",()=>{
 const input=[line("Header",50,740,420),...Array.from({length:4},(_,index)=>[line("A LEFT "+index,50,680-index*24),line("A RIGHT "+index,320,680-index*24)]).flat(),line("Second band",50,540,420),...Array.from({length:4},(_,index)=>[line("B LEFT "+index,50,500-index*24),line("B RIGHT "+index,320,500-index*24)]).flat()];
 assert.deepEqual(pdfLines(input,1,612).map(line=>line.text),["Header",...Array.from({length:4},(_,i)=>"A LEFT "+i),...Array.from({length:4},(_,i)=>"A RIGHT "+i),"Second band",...Array.from({length:4},(_,i)=>"B LEFT "+i),...Array.from({length:4},(_,i)=>"B RIGHT "+i)]);
});
test("single-column fragments and occasional right-aligned dates retain row order",()=>{
 const input=[line("Title",50,740,420),line("Work",50,680,200),line("2024",400,680,50),line("Body",50,656,480),line("Education",50,620,200),line("2020",400,620,50),line("Details",50,596,480)];
 assert.deepEqual(pdfLines(input,1,612).map(line=>line.text),["Title","Work 2024","Body","Education 2020","Details"]);
 const fragments=[line("Name",50,700,35),line("Surname",95,700,50),line("Plain text",50,680,200)];
 assert.deepEqual(pdfLines(fragments,1,612).map(line=>line.text),["Name Surname","Plain text"]);
});

