import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const writerSource = fs.readFileSync(new URL("../public/modules/novels/progress-writer.js", import.meta.url), "utf8");
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}; };
const settle = async () => {for(let i=0;i<24;i++)await Promise.resolve();};
class Element {
  constructor(tag="div"){this.tagName=tag.toUpperCase();this.children=[];this.events=new Map();this.attributes={};this.className="";this.style={setProperty(){}};this.dataset={};this.scrollHeight=2000;this.classList={toggle(){},add(){},remove(){}};}
  append(...children){for(const child of children){child.parentNode=this;this.children.push(child);}}
  appendChild(child){this.append(child);return child;}
  prepend(child){child.parentNode=this;this.children.unshift(child);}
  set textContent(value){this.text=String(value);this.children=[];}get textContent(){return(this.text||"")+this.children.map(c=>c.textContent||"").join("");}
  set innerHTML(value){this.children=[];this.text="";}get innerHTML(){return"";}
  addEventListener(name,listener){if(!this.events.has(name))this.events.set(name,[]);this.events.get(name).push(listener);}
  async fire(name){if(name==="click"&&this.disabled)return;for(const fn of this.events.get(name)||[])await fn({type:name,target:this,preventDefault(){},stopPropagation(){}});}
  setAttribute(key,value){this.attributes[key]=String(value);}removeAttribute(key){delete this.attributes[key];}
  matches(selector){return selector.startsWith(".")?this.className.split(" ").includes(selector.slice(1)):this.tagName===selector.toUpperCase();}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches?.(selector)?[child]:[]),...(child.querySelectorAll?.(selector)||[])]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getBoundingClientRect(){return{top:0,height:2000};}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}
}
function detail(revision="r1",recovery=false,index=1){
  const book={id:"book",sourceRealm:"server:synthetic",catalogRevision:revision,title:"Synthetic",author:"Fixture",chapterCount:2,
    progress:null,progressRecovery:recovery?{status:"needs_review",reason:"content_changed",previous:{chapterId:"old",chapterIndex:1,scrollRatio:0.6,catalogRevision:"older"},candidate:{chapterId:`${revision}-1`,chapterIndex:1,scrollRatio:0,catalogRevision:revision,title:"Candidate <script>"}}:null};
  const chapters=[1,2].map(i=>({id:`${revision}-${i}`,bookId:"book",index:i,title:`Chapter ${i}`,content:`synthetic body ${revision} ${i}`,charCount:50}));
  return{book,sourceRealm:book.sourceRealm,catalogRevision:revision,chapter:chapters[index-1],chapters:[],prev:chapters[index-2]||null,next:chapters[index]||null,chapterTotal:2,allChapters:chapters};
}
function harness({production=source,initial=detail(),respond}={}){
  const body=new Element("body"),grid=new Element();body.append(grid);const timers=new Map(),frames=[];let id=0;
  const document=new Element("document");document.body=body;document.createElement=tag=>new Element(tag);document.querySelector=selector=>body.querySelector(selector);document.querySelectorAll=selector=>body.querySelectorAll(selector);document.hidden=false;
  const window=new Element("window");Object.assign(window,{scrollY:0,innerHeight:800,setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(key){timers.delete(key);},requestAnimationFrame(fn){frames.push(fn);},scrollTo({top}){window.scrollY=top;}});
  const requests=[];let current=initial;
  const state={activeView:"novels",novel:{book:structuredClone(initial.book),chapters:structuredClone(initial.allChapters)}};
  const api=(url,options={})=>{const request={url,options};requests.push(request);if(respond){const result=respond(request);if(result!==undefined)return Promise.resolve(result);}
    const parsed=new URL(url,"http://synthetic.invalid");
    if(options.method==="POST")return Promise.resolve({progress:{...options.body}});
    if(parsed.pathname.endsWith("/catalog"))return Promise.resolve({sourceRealm:current.sourceRealm,catalogRevision:current.catalogRevision,chapters:current.allChapters,total:2});
    if(parsed.pathname.includes("/chapters/"))return Promise.resolve(detail(current.catalogRevision,Boolean(current.book.progressRecovery),Number(parsed.pathname.split("/").at(-1))));
    return Promise.resolve({book:current.book,chapters:[],chapterTotal:2});};
  window.fetch=(url,options)=>api(url,options);
  const context=vm.createContext({document,window,Element,URL,URLSearchParams,AbortController,console,Intl,Map,Set,Date,Promise,
    localStorage:{getItem(){return null;},setItem(){}},createNovelCollectionAdmin:()=>({ensureState(){},stopPolling(){}})});
  vm.runInContext(writerSource.replace("export function createNovelProgressWriter", "function createNovelProgressWriter"), context, { filename: "production-progress-writer.js" });
  vm.runInContext(production.replace(/^import .*\r?\n/gm,"").replace("export function createNovelPage","function createNovelPage")+"\nglobalThis.createPage=createNovelPage;",context,{filename:"production-novel-page.js"});
  const noop=()=>{};const page=context.createPage({api,state,els:{workGrid:grid},formatBytes:String,formatDateTime:String,formatNumber:String,
    cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,hidePersonProfile:noop,openAdminScript:noop,pushRoute:noop,replaceRoute:noop,resetProgressiveCoverLoading:noop,setMainHeader:noop,syncRouteAfterNavigation:noop});
  return{page,state,requests,window,document,grid,setCurrent(next){current=next;},async timers(){const readyFrames=frames.splice(0);readyFrames.forEach(fn=>fn());await settle();const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());await settle();},button(){return grid.querySelectorAll("button").find(b=>b.textContent==="确认从当前章节重新记录进度");}};
}
const tests=[];const test=(name,run)=>tests.push({name,run});let passed=0,negative=0;
test("public openChapter and timer save send the exact ID, revision and realm",async({production=source}={})=>{
  const h=harness({production});assert.equal(await h.page.openChapter("book",1),true);await h.timers();
  const get=h.requests.find(r=>r.url.includes("/chapters/1")),url=new URL(get.url,"http://synthetic.invalid");
  assert.equal(url.searchParams.get("catalogRevision"),"r1");assert.equal(url.searchParams.get("chapterId"),"r1-1");assert.equal(url.searchParams.get("sourceRealm"),"server:synthetic");
  const post=h.requests.find(r=>r.options.method==="POST");assert(post);assert.equal(post.options.body.chapterId,"r1-1");assert.equal(post.options.body.catalogRevision,"r1");assert.equal(post.options.body.sourceRealm,"server:synthetic");
});
test("recovery survives automatic timer, scroll and pagehide; only explicit successful confirmation clears it",async({production=source}={})=>{
  const pending=deferred();const h=harness({production,initial:detail("r1",true),respond:r=>r.options.method==="POST"?pending.promise:undefined});
  await h.page.openChapter("book",1);await h.timers();await h.window.fire("scroll");await h.timers();await h.window.fire("pagehide");await settle();
  assert.equal(h.requests.filter(r=>r.options.method==="POST").length,0);assert(h.state.novel.book.progressRecovery);
  assert(h.grid.textContent.includes("Candidate <script>"));assert.equal(h.grid.querySelectorAll("script").length,0);
  const button=h.button();assert(button);const clicked=button.fire("click");await settle();assert(button.disabled);assert(h.state.novel.book.progressRecovery);
  pending.resolve({progress:{chapterId:"r1-1",chapterIndex:1,scrollRatio:0,catalogRevision:"r1"}});await clicked;assert.equal(h.state.novel.book.progressRecovery,null);
});
test("failed confirmation keeps the old anchor and permits a retry",async()=>{
  let attempt=0;const h=harness({initial:detail("r1",true),respond:r=>r.options.method==="POST"&&++attempt===1?Promise.reject(new Error("synthetic 409")):undefined});
  await h.page.openChapter("book",1);const before=JSON.stringify(h.state.novel.book.progressRecovery);await h.button().fire("click");
  assert.equal(JSON.stringify(h.state.novel.book.progressRecovery),before);assert.equal(h.button().disabled,false);await h.button().fire("click");assert.equal(h.state.novel.book.progressRecovery,null);
});
test("a same-owner rerender during failed confirmation unlocks the currently visible button",async()=>{
  const pending=deferred();const h=harness({initial:detail("r1",true),respond:r=>r.options.method==="POST"?pending.promise:undefined});
  await h.page.openChapter("book",1);const clicked=h.button().fire("click");await settle();h.page.renderView();
  assert(h.button().disabled);pending.reject(new Error("synthetic save failure"));await clicked;
  assert.equal(h.button().disabled,false);assert(h.state.novel.book.progressRecovery);
});
test("late confirmation cannot erase a newer snapshot's recovery",async()=>{
  const pending=deferred(),nextPending=deferred();let writes=0;const h=harness({initial:detail("r1",true),respond:r=>r.options.method==="POST"?(++writes===1?pending.promise:nextPending.promise):undefined});
  await h.page.openChapter("book",1);const clicked=h.button().fire("click");await settle();
  const newer=detail("r2",true);h.setCurrent(newer);h.state.novel.book=structuredClone(newer.book);h.state.novel.chapter=null;h.state.novel.chapters=[];
  await h.page.openChapter("book",1);const nextButton=h.button();assert.equal(nextButton.disabled,false);
  const nextClick=nextButton.fire("click");await settle();assert(nextButton.disabled);
  pending.resolve({progress:{chapterId:"r1-1",catalogRevision:"r1",scrollRatio:0}});await clicked;await settle();
  assert.equal(h.state.novel.book.catalogRevision,"r2");assert(h.state.novel.book.progressRecovery);
  assert.equal(writes,2);nextPending.resolve({progress:{chapterId:"r2-1",chapterIndex:1,catalogRevision:"r2",scrollRatio:0}});await nextClick;
  assert.equal(h.state.novel.book.progressRecovery,null);
});
test("Escape closes reader panels while a catalog input or settings control has focus",async({production=source}={})=>{
  for (const [panel, tag] of [["catalogOpen", "input"], ["settingsOpen", "button"]]) {
    const h=harness({production});
    await h.page.openChapter("book",1);
    h.state.novel[panel]=true;
    h.page.renderView();
    const target=h.document.createElement(tag);
    target.closest=selector=>selector.split(",").map(value=>value.trim()).includes(tag)?target:null;
    const before=h.requests.length;
    let prevented=false;
    for (const listener of h.window.events.get("keydown")||[]) {
      await listener({key:"ArrowRight",target,preventDefault(){}});
    }
    assert.equal(h.requests.length,before,"arrow keys in panel controls must not navigate chapters");
    for (const listener of h.window.events.get("keydown")||[]) {
      await listener({key:"Escape",target,preventDefault(){prevented=true;}});
    }
    assert(prevented,`${panel}: Escape must be handled from a focused control`);
    assert.equal(h.state.novel.catalogOpen,false);
    assert.equal(h.state.novel.settingsOpen,false);
    assert.equal(h.grid.querySelector(".novel-reader-drawer"),null);
    assert.equal(h.grid.querySelector(".novel-settings-panel"),null);
    assert.equal(h.state.novel.chapter.index,1,"closing a panel must preserve the current chapter");
  }
});
test("a response from another revision cannot be mounted or cached under the current chapter",async()=>{
  const h=harness({respond:r=>r.url.includes("/chapters/1")?detail("r2"):undefined});assert.equal(await h.page.openChapter("book",1),false);
  assert.equal(h.state.novel.book.catalogRevision,"r1");assert.equal(h.state.novel.chapter,null);
});
for(const item of tests){await item.run();passed++;console.log(`PASS ${item.name}`);}
for(const [name,from,to,prefix] of [
  ["auto-save clears recovery", "if (book.progressRecovery && !options.confirmRecovery) return;", "", "recovery survives"],
  ["save omits revision identity", "...(book.catalogRevision ? { catalogRevision: book.catalogRevision, chapterId: chapter.id } : {})", "", "public openChapter"],
  ["focused controls swallow Escape", '      if (event.key === "Escape" && (state.novel.catalogOpen || state.novel.settingsOpen)) {', '      if (event.target instanceof Element && event.target.closest("input, select, textarea, button, a")) return;\n      if (event.key === "Escape" && (state.novel.catalogOpen || state.novel.settingsOpen)) {', "Escape closes reader panels"]
]){
  assert.equal(source.split(from).length,2);let error;try{await tests.find(t=>t.name.startsWith(prefix)).run({production:source.replace(from,to)});}catch(e){error=e;}
  assert.equal(error?.code,"ERR_ASSERTION",name);negative++;console.log(`CONTROL rejected ${name}`);
}
console.log(`Web novel identity: ${passed} full-module VM/DOM-double scenarios passed; ${negative} behavior controls rejected. No browser, network or real database.`);
