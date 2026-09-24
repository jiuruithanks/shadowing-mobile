"use strict";
const $ = id => document.getElementById(id);
const audio = $("referenceAudio");
const markedMode=document.body.dataset.practice==="marked";
$("doneButton")?.remove();
const state = {
  lesson:null, lessons:[], catalog:[], item:null, unit:"找兼职", turn:0, playing:false, pending:false, loop:false,
  epoch:0, voices:[], cache:new Map(), kana:new Map(), loadedKey:"",
  recorder:null, stream:null, recordingPending:false, recordingSaving:false, recordTimer:null, recordingMeter:null,
  recordingUrl:"", takes:[], db:null, synthesis:null, previewEpoch:0, previewing:false, previewKey:"",
  voiceGroups:new Map(), lessonVoices:new Map(), voiceProfiles:null, voiceDraft:null,
  analysisEpoch:0, analysisWork:new Map(), analysisView:null, analysisFrameReady:false,
  recordingIndex:new Map(), recordingLoaded:new Set(), recordingIndexStatus:"loading", navMode:"unit"
};
const prefix = "textbook-v1:";
function read(key, fallback="") {
  try { return localStorage.getItem(prefix+key) ?? fallback; } catch { return fallback; }
}
function save(key,value) {
  try { localStorage.setItem(prefix+key,value); return true; }
  catch { notice("本地空间不足，设置或笔记未保存。"); return false; }
}
function notice(text) { $("notice").textContent=text; }
function icons() { if(window.lucide) lucide.createIcons(); }
function setIcon(button,name,label) {
  button.replaceChildren();
  const icon=document.createElement("i"); icon.dataset.lucide=name;
  button.append(icon); button.title=label; button.setAttribute("aria-label",label); icons();
}
function time(seconds) {
  seconds=Number.isFinite(seconds)?Math.max(0,Math.floor(seconds)):0;
  return Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
}
async function api(path,payload) {
  if(window.TextbookOffline)return TextbookOffline.api(path,payload);
  const response=await fetch(path,payload===undefined?{}:{
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
  });
  if(!response.ok) {
    let detail=""; try { detail=(await response.json()).detail; } catch {}
    throw new Error(typeof detail==="string"&&detail?detail:"请求失败（"+response.status+"）");
  }
  return response.json();
}
function itemTurns(item=state.item) { return item?.turns || []; }
function voiceScope(item=state.item,lesson=state.lesson) {
  return JSON.stringify([lesson?.id,item?.voice_group||item?.id]);
}
function groupVoiceSettings(item=state.item,lesson=state.lesson) {
  const scope=voiceScope(item,lesson);
  if(!state.voiceGroups.has(scope)) {
    let stored;try{stored=JSON.parse(read("roleVoices:"+scope,"{}"));}catch{}
    const entries=stored&&typeof stored==="object"&&!Array.isArray(stored)?Object.entries(stored):[];
    state.voiceGroups.set(scope,Object.fromEntries(entries.filter(([,s])=>s&&Number.isSafeInteger(s.style_id)&&
      synthesisFields.every(f=>Number.isFinite(s[f.key])&&s[f.key]>=f.min&&s[f.key]<=f.max))));
  }
  return state.voiceGroups.get(scope);
}
function lessonRoles(lesson=state.lesson) {
  const roles=new Map();
  for(const item of lesson.items) {
    const labels=item.kind==="自由回答"?["我"]:itemTurns(item).map(t=>t.role);
    for(const role of new Set(labels)) {
      if(!roles.has(role))roles.set(role,[]);
      roles.get(role).push(item);
    }
  }
  return roles;
}
function validSettings(s) {
  return s&&Number.isSafeInteger(s.style_id)&&synthesisFields.every(f=>
    Number.isFinite(s[f.key])&&s[f.key]>=f.min&&s[f.key]<=f.max);
}
function settingsKey(s) {return JSON.stringify([s.style_id,...synthesisFields.map(f=>s[f.key])]);}
function legacyLessonVoiceSettings(lesson=state.lesson) {
  const id=lesson.id;
  if(!state.lessonVoices.has(id)) {
    let stored;try{stored=JSON.parse(read("lessonVoices:"+id,"null"));}catch{}
    const overrides=stored?.overrides;
    if(validSettings(stored?.defaultSettings)&&overrides&&typeof overrides==="object"&&!Array.isArray(overrides)) {
      state.lessonVoices.set(id,{defaultSettings:stored.defaultSettings,
        overrides:Object.fromEntries(Object.entries(overrides).filter(([,s])=>validSettings(s))),conflicts:{}});
    } else {
      // Keep the old keys intact. Unify only on Apply; conflicting assignments remain visible in the draft.
      const profile={defaultSettings:{...state.synthesis},overrides:{},conflicts:{},legacy:true};
      for(const [role,items] of lessonRoles(lesson)) {
        const variants=new Map();
        for(const item of items) {
          const old=groupVoiceSettings(item,lesson);
          if(Object.hasOwn(old,role))variants.set(settingsKey(old[role]),old[role]);
        }
        if(variants.size)profile.overrides[role]={...variants.values().next().value};
        if(variants.size>1)profile.conflicts[role]=variants.size;
      }
      state.lessonVoices.set(id,profile);
    }
  }
  return state.lessonVoices.get(id);
}
function commonRoleKey(role) {return role==="店員"?"店员":role;}
function emptyLessonVoice() {return {defaultSettings:null,overrides:{},conflicts:{},legacyRoles:[]};}
function commonSettings(profiles,role="",lessonDefault=null) {
  return profiles.common.overrides[commonRoleKey(role)]||lessonDefault||profiles.common.defaultSettings;
}
function voiceProfiles() {
  if(state.voiceProfiles)return state.voiceProfiles;
  let stored;try{stored=JSON.parse(read("voiceProfiles:v2","null"));}catch{}
  const cleanOverrides=raw=>Object.fromEntries(Object.entries(raw||{}).filter(([,s])=>validSettings(s)));
  if(stored?.version===2&&validSettings(stored.common?.defaultSettings)) {
    const lessons={};
    for(const [id,p] of Object.entries(stored.lessons||{})) {
      if(!p||typeof p!=="object")continue;
      lessons[id]={defaultSettings:validSettings(p.defaultSettings)?p.defaultSettings:null,
        overrides:cleanOverrides(p.overrides),conflicts:p.conflicts||{},
        legacyRoles:Array.isArray(p.legacyRoles)?p.legacyRoles:[]};
    }
    return state.voiceProfiles={version:2,common:{defaultSettings:stored.common.defaultSettings,
      overrides:cleanOverrides(stored.common.overrides)},lessons};
  }
  const old=state.lessons.map(lesson=>({lesson,profile:legacyLessonVoiceSettings(lesson)}));
  const first=old.find(({profile})=>!profile.legacy)?.profile;
  const profiles={version:2,common:{defaultSettings:{...(first?.defaultSettings||state.synthesis)},overrides:{}},lessons:{}};
  // Seed shared voices from saved assignments; keep every audible difference as a lesson override.
  // Old storage is untouched and the new snapshot is written only when the user applies settings.
  for(const {profile} of old)for(const [role,settings] of Object.entries(profile.overrides)) {
    const key=commonRoleKey(role);
    if(!Object.hasOwn(profiles.common.overrides,key))profiles.common.overrides[key]={...settings};
  }
  for(const {lesson,profile} of old) {
    const local=emptyLessonVoice();profiles.lessons[lesson.id]=local;
    if(profile.legacy&&!Object.keys(profile.overrides).length)continue;
    if(settingsKey(profile.defaultSettings)!==settingsKey(profiles.common.defaultSettings))local.defaultSettings={...profile.defaultSettings};
    for(const [role,items] of lessonRoles(lesson)) {
      const variants=new Map();
      for(const item of items) {
        const overrides=profile.legacy?groupVoiceSettings(item,lesson):profile.overrides;
        const settings=overrides[role]||profile.defaultSettings;
        variants.set(settingsKey(settings),settings);
      }
      const settings=variants.values().next().value;
      if(variants.size>1) {
        local.legacyRoles.push(role);local.conflicts[role]=variants.size;local.overrides[role]={...settings};
      } else if(settingsKey(settings)!==settingsKey(commonSettings(profiles,role,local.defaultSettings))) {
        local.overrides[role]={...settings};
      }
    }
  }
  return state.voiceProfiles=profiles;
}
function lessonVoiceSettings(profiles=voiceProfiles()) {return profiles.lessons[state.lesson.id]||emptyLessonVoice();}
function assignedSettings(turn=itemTurns()[state.turn],item=state.item) {
  if(window.TextbookOffline)return turn?.offlineSettings||state.synthesis;
  if(!state.synthesis)return null;
  const profiles=voiceProfiles(),profile=lessonVoiceSettings(profiles),role=turn?.role||"";
  if(profile.legacyRoles.includes(role)) {
    return groupVoiceSettings(item)[role]||profile.defaultSettings||profiles.common.defaultSettings;
  }
  return profile.overrides[role]||commonSettings(profiles,role,profile.defaultSettings);
}
function availableTurns(item) {
  if(item.kind!=="自由回答")return itemTurns(item);
  const text=read("answer:"+item.id).trim();return text?[{role:"我",ja:text,zh:""}]:[];
}
const exerciseGroupCache=new WeakMap();
function exerciseGroup(item=state.item) {
  if(!item||!state.lesson)return null;
  if(!exerciseGroupCache.has(state.lesson)) {
    const buckets=new Map(),groups=new Map();
    for(const candidate of state.lesson.items) {
      const number=/^(.*?)\s*[·・]\s*(例\d*|\d+)$/.exec(candidate.number||"");
      if(!number||candidate.kind==="自由回答"||!itemTurns(candidate).length)continue;
      const key=JSON.stringify([candidate.unit,candidate.book,candidate.page,candidate.title,number[1].trim()]);
      if(!buckets.has(key))buckets.set(key,[]);
      buckets.get(key).push(candidate);
    }
    for(const items of buckets.values()) {
      if(items.length<2)continue;
      const base=items[0],turns=itemTurns(base);
      if(items.some(i=>i.turns.length!==turns.length||i.turns.some((t,n)=>t.role!==turns[n].role)))continue;
      const different=turns.map((turn,n)=>items.some(i=>i.turns[n].ja!==turn.ja||i.turns[n].zh!==turn.zh)?n:-1).filter(n=>n>=0);
      // Only merge a single replacement position, never merely similar dialogue titles.
      if(different.length!==1)continue;
      const group={items,variable:different[0],base,number:base.number.replace(/\s*[·・]\s*(例\d*|\d+)$/,"").trim()};
      items.forEach(i=>groups.set(i.id,group));
    }
    exerciseGroupCache.set(state.lesson,groups);
  }
  return exerciseGroupCache.get(state.lesson).get(item.id)||null;
}
function sentenceSources(item,index) {
  const group=exerciseGroup(item);
  return group&&index!==group.variable?group.items:[item];
}
function sentenceTagSources(index) {
  return sentenceSources(state.item,index).map(item=>TextbookTags.sentence(state.lesson,item,index,itemTurns(item)[index]));
}
function variantLabel(item) {return item.number.match(/[·・]\s*(例\d*|\d+)$/)?.[1]||item.number;}
function groupSentences(group) {
  return group.base.turns.flatMap((_,index)=>index===group.variable?
    group.items.map(item=>({item,index})):[{item:group.base,index}]);
}
function recordingRatio(recorded,total) {
  if(!total)return "暂无可录句子";
  const percent=Math.round(recorded/total*100);
  return `已录 ${recorded}/${total} 句（${percent}%） · 未录 ${total-recorded}/${total} 句（${100-percent}%）`;
}
function groupRecordingProgress(item) {
  const group=exerciseGroup(item);if(!group)return recordingProgress(item);
  const progress=new Map(group.items.map(i=>[i.id,recordingProgress(i)]));
  const counts=groupSentences(group).map(s=>progress.get(s.item.id).counts[s.index]);
  const known=[...progress.values()].every(p=>p.known),total=counts.length,recorded=counts.filter(Boolean).length;
  return {known,total,recorded,counts,status:!known?"loading":recorded===total?"complete":recorded?"partial":"none",
    label:known?recordingRatio(recorded,total):"正在读取录音…",
    extras:[...new Set([...progress.values()].flatMap(p=>p.extras))]};
}
function refreshGroupControls() {
  const group=exerciseGroup();if(!group||markedMode)return;
  for(const b of document.querySelectorAll(".exercise-variants [data-variant]")) {
    const item=group.items.find(i=>i.id===b.dataset.variant);
    if(!item)continue;
    const recorded=recordingProgress(item).counts[group.variable]>0;
    b.querySelector("small").textContent=recorded?"已录":"未录";
  }
}
function renderVariantTabs(group) {
  const bar=document.createElement("div");bar.className="exercise-variants";bar.setAttribute("role","tablist");bar.setAttribute("aria-label","切换替换句");
  for(const item of group.items) {
    const b=document.createElement("button");b.type="button";b.role="tab";b.dataset.variant=item.id;
    b.setAttribute("aria-selected",String(item===state.item));b.setAttribute("aria-controls","variantSentence");
    b.id="variant-"+item.id;b.tabIndex=item===state.item?0:-1;
    b.append(document.createTextNode(variantLabel(item)),document.createElement("small"));
    b.title=item.number+" · "+item.kind;b.onclick=()=>selectItem(item.id,group.variable);
    b.onkeydown=event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
      event.preventDefault();const buttons=[...bar.children],index=buttons.indexOf(b);
      const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
      buttons[next].click();document.getElementById(buttons[next].id)?.focus();
    };
    bar.append(b);
  }
  return bar;
}
function recordingMetadata(take) {
  const s=take.sentence;
  return {id:take.id,exercise:take.exercise,created:take.created,hasAudio:take.blob instanceof Blob&&take.blob.size>0,
    sentence:s?{lessonId:s.lessonId,index:s.index,role:s.role,text:s.text}:null};
}
function indexRecording(take) {
  if(!state.recordingIndex.has(take.exercise))state.recordingIndex.set(take.exercise,new Map());
  const metadata=recordingMetadata(take),rows=state.recordingIndex.get(take.exercise);
  if(metadata)rows.set(take.id,metadata);else rows.delete(take.id);
}
async function loadRecordingIndex() {
  state.recordingIndexStatus="loading";
  try {
    const db=await state.db,index=new Map();
    // Retain only sentence identities, not every recording blob or analysis result.
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("recordings","readonly");
      const request=tx.objectStore("recordings").openCursor();
      request.onsuccess=()=>{
        const cursor=request.result;if(!cursor)return;
        const take=cursor.value,metadata=recordingMetadata(take);
        if(metadata) {
          if(!index.has(take.exercise))index.set(take.exercise,new Map());
          index.get(take.exercise).set(take.id,metadata);
        }
        cursor.continue();
      };
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
    state.recordingIndex=index;state.recordingIndexStatus="ready";
  } catch {state.recordingIndexStatus="error";}
  updateRecordingProgress();
}
function isLessonRecording(take) {
  // Before course selection existed, all unbound recordings belonged to lesson 1.
  return (take.sentence?.lessonId||"dekiru-2e-intermediate-01")===state.lesson.id;
}
function recordingTurn(take,item,turns=item?availableTurns(item):[]) {
  const s=take.sentence,turn=s&&turns[s.index];
  return take.hasAudio&&s?.lessonId===state.lesson.id&&Number.isInteger(s.index)&&turn&&
    turn.role===s.role&&turn.ja===s.text?s.index:-1;
}
function unmatchedRecordings() {
  const items=new Map(state.lesson.items.map(item=>[item.id,item])),rows=[];
  for(const [id,takes] of state.recordingIndex) {
    const item=items.get(id),turns=item?availableTurns(item):[];
    for(const take of takes.values()) {
      if(isLessonRecording(take)&&recordingTurn(take,item,turns)<0)rows.push(take);
    }
  }
  return rows.sort((a,b)=>(b.created||0)-(a.created||0));
}
function recordingProgress(item) {
  const turns=availableTurns(item),counts=turns.map(()=>0);
  const known=state.recordingIndexStatus==="ready"||state.recordingLoaded.has(item.id);
  let legacy=0,outdated=0;
  for(const take of state.recordingIndex.get(item.id)?.values()||[]) {
    if(!isLessonRecording(take))continue;
    const s=take.sentence;
    if(!s){legacy++;continue;}
    const index=recordingTurn(take,item,turns);
    if(index>=0)counts[index]++;
    else outdated++;
  }
  const group=exerciseGroup(item);
  if(group)for(let index=0;index<turns.length;index++) {
    if(index===group.variable)continue;
    for(const other of group.items)if(other!==item)for(const take of state.recordingIndex.get(other.id)?.values()||[]) {
      if(recordingTurn(take,other)===index)counts[index]++;
    }
  }
  const recorded=counts.filter(n=>n>0).length,total=turns.length;
  const status=!known?state.recordingIndexStatus:!total?"empty":!recorded?"none":recorded===total?"complete":"partial";
  const label=!known?(status==="error"?"录音状态无法读取":"正在读取录音…"):
    recordingRatio(recorded,total);
  const unmatched=legacy+outdated;
  const extras=unmatched?[`未对应录音 ${unmatched} 条`]:[];
  return {known,counts,recorded,total,status,label,extras};
}
function updateRecordingProgress(refreshNav=true) {
  if(!state.lesson)return;
  if(markedMode)MarkedPractice.renderNav();
  if(refreshNav&&state.navMode==="recordings"){renderNav();return;}
  $("unmatchedCount").textContent=state.recordingIndexStatus==="ready"?String(unmatchedRecordings().length):"—";
  let navTotal=0,navRecorded=0,navKnown=true;
  for(const el of $("exerciseNav").querySelectorAll(".exercise-recording")) {
    const item=state.lesson.items.find(i=>i.id===el.dataset.item);if(!item)continue;
    const p=groupRecordingProgress(item);
    navTotal+=p.total;navRecorded+=p.recorded;navKnown=navKnown&&p.known;
    el.dataset.status=p.status;
    el.firstElementChild.textContent=p.known?(p.total?`已录 ${p.recorded}/${p.total}`:"暂无句子"):"录音 —";
    el.lastElementChild.textContent=[p.known&&p.total?`未录 ${p.total-p.recorded}/${p.total}`:"",p.extras.length?"有未对应录音":""].filter(Boolean).join(" · ");
    el.lastElementChild.hidden=!el.lastElementChild.textContent;
    el.title=[p.label,...p.extras].join("；");el.setAttribute("aria-label",el.title);
  }
  if(!markedMode)$("doneCount").textContent=navKnown?(navTotal?`已录 ${navRecorded}/${navTotal} · 未录 ${navTotal-navRecorded}/${navTotal}`:""):"读取录音中…";
  if(!state.item)return;
  const p=markedMode?recordingProgress(state.item):groupRecordingProgress(state.item);
  $("recordingProgress").dataset.status=p.status;
  $("recordingProgressText").textContent=p.label;
  $("recordingProgressExtra").textContent=p.extras.join(" · ");
  $("recordingProgressExtra").hidden=!p.extras.length;
  $("recordingProgressBar").hidden=!p.known||!p.total;
  $("recordingProgressBar").max=p.total||1;$("recordingProgressBar").value=p.recorded;
  for(const el of $("turnList").querySelectorAll(".turn-recording")) {
    const count=recordingProgress(state.item).counts[Number(el.dataset.turn)]||0;
    el.dataset.status=!p.known?"unknown":count?"complete":"none";
    el.textContent=!p.known?"录音状态未知":count?"已录音":"未录音";
    el.title=count?`本句已保存 ${count} 条录音`:el.textContent;
  }
  refreshGroupControls();
}
function previewSample() {
  const draft=state.voiceDraft,role=draft?.role;
  const matches=t=>draft?.scope==="common"?commonRoleKey(t.role)===role:t.role===role;
  if(!role||itemTurns()[state.turn]&&matches(itemTurns()[state.turn]))return {lesson:state.lesson,item:state.item,turn:itemTurns()[state.turn]};
  const lessons=draft?.scope==="common"?[state.lesson,...state.lessons.filter(l=>l!==state.lesson)]:[state.lesson];
  for(const lesson of lessons)for(const item of lesson.items) {
    const turn=availableTurns(item).find(matches);
    if(turn)return {lesson,item,turn};
  }
  return {};
}
function previewTurn() {return previewSample().turn;}
function turnKey() {
  return JSON.stringify([state.item?.id,state.turn,assignedSettings(),itemTurns()[state.turn]?.ja]);
}
function updatePlayButton() {
  setIcon($("play"),state.playing?"pause":"play",state.playing?"暂停":"播放");
  $("play").classList.toggle("busy",state.pending);
  $("play").setAttribute("aria-busy",String(state.pending));
}
function cancelPlayback() {
  state.epoch++; state.playing=false; state.pending=false; audio.pause(); updatePlayButton();
}
function clearAudio() {
  state.loadedKey=""; audio.removeAttribute("src"); audio.load();
  $("seek").value=0; $("audioTime").textContent="0:00 / 0:00";
}
function activeTurn() {
  if(state.item&&itemTurns().length)save("turn:"+state.item.id,String(state.turn));
  document.querySelectorAll(".turn").forEach(button=>{
    const index=Number(button.dataset.turn);
    button.classList.toggle("active",index===state.turn);
    button.setAttribute("aria-current",index===state.turn?"true":"false");
  });
  const turns=itemTurns();
  $("currentLabel").textContent=turns.length?(state.turn+1)+" / "+turns.length+" · "+turns[state.turn].role:"暂无可播放文本";
  updateVoiceSummary();
  renderTakes();
  if(markedMode)MarkedPractice.updateControls();
}
function renderNav() {
  if(markedMode){MarkedPractice.renderNav();return;}
  const query=$("search").value.trim().toLowerCase();
  const recorded=state.navMode==="recordings";
  const matches=state.lesson.items.filter(item=>(recorded?recordingProgress(item).recorded>0:item.unit===state.unit)&&(!query||
    [item.title,item.prompt,item.book,item.page,item.number,...availableTurns(item).map(t=>t.ja)].join(" ").toLowerCase().includes(query)));
  const seen=new Set(),available=matches.filter(item=>{
    const id=exerciseGroup(item)?.base.id||item.id;if(seen.has(id))return false;seen.add(id);return true;
  });
  if(!recorded) {
    const books=[...new Set(available.map(item=>item.book))];
    available.sort((a,b)=>books.indexOf(a.book)-books.indexOf(b.book));
  }
  $("recordingsTools").hidden=!recorded;
  $("itemCount").textContent=available.length+" 个练习";
  $("exerciseNav").replaceChildren();
  let book="";
  for(const item of available) {
      const group=exerciseGroup(item),selected=group?.items.includes(state.item);
      if(!recorded&&item.book!==book) {
        const heading=document.createElement("div");heading.className="nav-book";heading.textContent=item.book;
        $("exerciseNav").append(heading);book=item.book;
      }
      const button=document.createElement("button");
      button.className="exercise-link"+(item.id===state.item?.id||selected?" active":"")+(availableTurns(item).length?"":" pending");
      button.dataset.item=item.id;button.title=item.prompt;
      const label=document.createElement("span");label.className="exercise-label";
      const title=document.createElement("span");title.textContent=item.title;
      const source=document.createElement("small");source.textContent=(recorded?item.book+" · ":"")+item.page+"页 · "+(group?group.number+" · "+group.items.length+" 个版本":item.number);
      label.append(title,source);button.append(label);
      const progress=document.createElement("span");progress.className="exercise-recording";progress.dataset.item=item.id;
      progress.append(document.createElement("span"),document.createElement("small"));button.append(progress);
      button.addEventListener("click",()=>{
        const target=!query&&!recorded&&selected?state.item:item;
        selectItem(target.id,recorded?recordingProgress(target).counts.findIndex(n=>n>0):undefined);
      });
      $("exerciseNav").append(button);
  }
  if(!available.length) {
    const p=document.createElement("p");p.className="muted";
    p.textContent=recorded&&state.recordingIndexStatus!=="ready"?"录音列表未完整读取，请重试。":query?"没有匹配的练习":recorded?"还没有对应当前句子的录音":"没有练习";
    $("exerciseNav").append(p);
  }
  updateRecordingProgress(false);icons();
}
function renderTabs() {
  if(markedMode)return;
  $("unitTabs").replaceChildren();
  for(const unit of state.lesson.units) {
    const b=document.createElement("button"); b.role="tab"; b.textContent=unit;
    b.setAttribute("aria-selected",String(state.navMode==="unit"&&unit===state.unit));
    b.onclick=()=>{
      if(unit===state.unit&&state.navMode==="unit")return;
      if(isRecording()) { notice("请先停止录音，再切换练习。"); return; }
      state.navMode="unit";saveLessonNav();state.unit=unit;$("search").value="";
      selectItem(state.lesson.items.find(i=>i.unit===unit).id);
    };
    $("unitTabs").append(b);
  }
  const recorded=document.createElement("button");recorded.role="tab";recorded.textContent="已有录音";
  recorded.setAttribute("aria-selected",String(state.navMode==="recordings"));
  recorded.onclick=()=>{
    state.navMode="recordings";saveLessonNav();$("search").value="";renderTabs();renderNav();
  };
  $("unitTabs").append(recorded);
}
function saveLessonNav() {
  save("navMode:"+state.lesson.id,state.navMode);
  if(state.lesson.number===1)save("navMode",state.navMode);
}
function isRecording() { return state.recordingPending||state.recordingSaving||Boolean(state.recorder&&state.recorder.state!=="inactive"); }
function readPersonal(item) {
  if(item.kind!=="自由回答")return;
  const text=read("answer:"+item.id).trim();
  item.turns=text?[{role:"我",ja:text,zh:"",user:true}]:[];
}
async function selectItem(id,preferredTurn) {
  const item=state.lesson.items.find(i=>i.id===id); if(!item)return;
  if(isRecording()) { notice("请先停止录音，再切换练习。"); return; }
  stopPreview(); cancelPlayback(); clearAudio(); $("recordedAudio").pause();
  if($("voiceDialog").open)$("voiceDialog").close();
  if($("analysisDialog").open)closeSentenceAnalysis();
  document.body.classList.remove("nav-open"); $("navToggle").setAttribute("aria-expanded","false");
  state.item=item; state.unit=item.unit; state.takes=[]; readPersonal(item);
  const lastTurn=preferredTurn===undefined?Number(read("turn:"+id,"0")):preferredTurn;
  state.turn=Number.isInteger(lastTurn)&&lastTurn>=0&&lastTurn<itemTurns().length?lastTurn:0;
  save("lastItem:"+state.lesson.id,id);
  if(state.lesson.number===1)save("lastItem",id);
  const url=new URL(location.href);url.hash=id;url.searchParams.delete("turn");
  if(state.lesson.number!==1||url.searchParams.has("lesson"))url.searchParams.set("lesson",String(state.lesson.number).padStart(2,"0"));
  history.replaceState(null,"",url); renderTabs(); renderNav();
  $("sourceLabel").textContent="第"+state.lesson.number+"课 / "+item.unit+" / "+item.book+" "+item.page+"页 / "+item.number;
  $("exerciseTitle").textContent=item.title; $("kindLabel").textContent=item.kind;
  $("exercisePrompt").textContent=item.prompt; $("exerciseNote").textContent=item.note;
  document.querySelector(".practice").classList.toggle("has-group",!markedMode&&Boolean(exerciseGroup(item)));
  $("exercisePrompt").hidden=!markedMode&&Boolean(exerciseGroup(item))&&["按教材原例练习。","按题目和图片展开的参考答案。","按原页提示练习。"].includes(item.prompt);
  $("freeAnswer").hidden=item.kind!=="自由回答"; $("personalText").value=read("answer:"+id);
  $("noteText").value=read("note:"+id); $("noteStatus").textContent="";
  document.querySelector('label[for="noteText"]').textContent=exerciseGroup(item)?variantLabel(item)+" · 练习笔记":"练习笔记";
  renderTurns(); renderRelated(); notice(""); await loadTakes(id);
}
function renderRelated() {
  const container=$("related"); container.replaceChildren();
  if(markedMode)return;
  if(!state.item.related.length)return;
  const label=document.createElement("span"); label.textContent="关联练习"; container.append(label);
  for(const id of state.item.related) {
    const item=state.lesson.items.find(i=>i.id===id); if(!item)continue;
    const a=document.createElement("a"); a.href="#"+id; a.textContent=item.book+" "+item.page+"页 · "+item.number;
    a.onclick=e=>{e.preventDefault(); $("search").value=""; selectItem(id);}; container.append(a);
  }
}
function renderTurns() {
  const list=$("turnList"); list.replaceChildren(); const turns=itemTurns();
  const group=markedMode?null:exerciseGroup();
  $("turnCount").textContent=turns.length?turns.length+" 段":"";
  $("play").disabled=!turns.length||!state.voices.length;
  $("previous").disabled=!turns.length; $("next").disabled=!turns.length;
  if(!turns.length) {
    const p=document.createElement("p"); p.className="empty-state";
    p.textContent=state.item.kind==="自由回答"?"这道题结合自己的情况回答。":
      state.item.kind==="原页词表"?"打开教材原页查看本课词表。":"此题所需音频或页面尚未提供。";
    list.append(p);
  }
  for(const [index,turn] of turns.entries()) {
    if(markedMode&&index!==state.turn)continue;
    const row=document.createElement("div");row.className="tagged-turn"+(group?" grouped-turn":"");
    if(group&&index===group.variable){list.append(renderVariantTabs(group));row.classList.add("variant-sentence");row.id="variantSentence";row.setAttribute("role","tabpanel");row.setAttribute("aria-labelledby","variant-"+state.item.id);}
    const button=document.createElement("button"); button.className="turn"; button.dataset.turn=index; button.title="从这里播放";
    const role=document.createElement("span"); role.className="turn-role"; role.textContent=turn.role;
    if(group&&index!==group.variable){const common=document.createElement("small");common.className="common-turn-label";common.textContent="共同句";role.append(common);}
    const content=document.createElement("span"); content.className="turn-content";
    const ja=document.createElement("span"); ja.className="turn-ja"; ja.lang="ja"; ja.textContent=turn.ja;
    const zh=document.createElement("span"); zh.className="turn-zh"; zh.textContent=turn.zh;
    const n=document.createElement("span"); n.className="turn-index"; n.textContent=String(index+1).padStart(2,"0");
    const status=document.createElement("span");status.className="turn-recording";status.dataset.turn=index;
    const tags=document.createElement("span");tags.className="turn-tags";tags.dataset.turn=index;
    content.append(ja,zh,status,tags); button.append(role,content,n); button.onclick=()=>playTurn(index);
    const tools=document.createElement("div");tools.className="turn-tag-tools";
    const tagButton=TextbookTags.iconButton("tag","标记第 "+(index+1)+" 句");tagButton.dataset.turn=index;
    tagButton.onclick=()=>{
      if(isRecording()){notice("请先结束录音，再编辑标记。");return;}
      try{const sources=sentenceTagSources(index);TextbookTags.openPicker(sources[0],sources.slice(1));}
      catch(e){notice(e.message);}
    };
    tools.append(tagButton);
    row.append(button,tools);list.append(row);
    addRuby(ja,turn.ja);
  }
  if(group){
    const nav=document.createElement("div");nav.className="variant-navigation";
    const label=document.createElement("span"),index=group.items.indexOf(state.item);label.textContent=`${variantLabel(state.item)} · ${index+1}/${group.items.length}`;
    const controls=document.createElement("div");
    for(const [step,icon,title] of [[-1,"chevron-left","上一个版本"],[1,"chevron-right","下一个版本"]]) {
      const b=TextbookTags.iconButton(icon,title);b.disabled=!group.items[index+step];b.onclick=()=>selectItem(group.items[index+step].id,group.variable);controls.append(b);
    }
    nav.append(label,controls);list.append(nav);
  }
  activeTurn(); applyDisplay();updateRecordingProgress();updateSentenceTags();icons();
  if(markedMode)MarkedPractice.updateControls();
}
function updateSentenceTags() {
  if(!state.item)return;
  try {
    const data=TextbookTags.read();
    for(const row of $("turnList").querySelectorAll(".tagged-turn")) {
      const button=row.querySelector(".turn-tag-tools button"),index=Number(button.dataset.turn),turn=itemTurns()[index];
      if(!turn)continue;
      const sources=sentenceTagSources(index),labels=TextbookTags.labels(sources[0],data,sources.slice(1));
      TextbookTags.chips(row.querySelector(".turn-tags"),labels);
      button.setAttribute("aria-pressed",String(labels.length>0));
      button.title="标记第 "+(index+1)+" 句"+(labels.length?"："+labels.map(t=>t.name).join("、"):"");
      button.setAttribute("aria-label",button.title);
    }
  }catch(e){notice(e.message);}
}
TextbookTags.subscribe(updateSentenceTags);
async function addRuby(target,text) {
  try {
    if(!state.kana.has(text))state.kana.set(text,api("/api/kana",{text}).catch(e=>{state.kana.delete(text);throw e;}));
    const result=await state.kana.get(text); if(!target.isConnected)return;
    const tokens=result.tokens||[]; if(tokens.map(t=>t.surface).join("").normalize("NFKC").trim()!==text.normalize("NFKC").trim())return;
    target.replaceChildren();
    for(const token of tokens) {
      if(/[一-龯々]/.test(token.surface)&&token.reading&&token.reading!==token.surface) {
        const ruby=document.createElement("ruby"); ruby.append(document.createTextNode(token.surface));
        const rt=document.createElement("rt"); rt.textContent=token.reading; ruby.append(rt); target.append(ruby);
      } else target.append(document.createTextNode(token.surface));
    }
  } catch { /* Keep source text usable if the local reading service is unavailable. */ }
}
function applyDisplay() {
  const list=$("turnList");
  list.classList.toggle("hide-ruby",!$("showRuby").checked);
  list.classList.toggle("hide-chinese",!$("showChinese").checked);
  list.classList.toggle("prompt-mode",document.querySelector('[name="mode"]:checked').value==="prompt");
}
async function audioFor(turn,settings) {
  if(window.TextbookOffline)return TextbookOffline.audioFor(turn);
  if(!settings||!state.voices.some(v=>v.style_id===settings.style_id))
    throw new Error("“"+(turn.role||"当前角色")+"”的音色或风格未安装，请在配音设置中重新选择。");
  const key=JSON.stringify([turn.ja,settings]);
  if(!state.cache.has(key))state.cache.set(key,api("/api/textbook/tts",{text:turn.ja,...settings})
    .catch(e=>{state.cache.delete(key);throw e;}));
  return state.cache.get(key);
}
function applyPlaybackSpeed() {
  const rate=Number($("speed").value);
  // Loading another sentence resets playbackRate to defaultPlaybackRate.
  audio.defaultPlaybackRate=rate;
  audio.playbackRate=rate;
}
audio.addEventListener("loadedmetadata",applyPlaybackSpeed);
async function playTurn(index) {
  if(isRecording()) { notice("录音中，停止后可以播放。"); return; }
  stopPreview();
  const turns=itemTurns(); if(!turns[index]||!state.voices.length)return;
  const generation=++state.epoch; audio.pause(); $("recordedAudio").pause();
  state.turn=index; state.playing=true; state.pending=true; state.loadedKey="";
  activeTurn(); updatePlayButton(); notice("正在准备本地配音…");
  try {
    const result=await audioFor(turns[index],{...assignedSettings(turns[index])});
    if(generation!==state.epoch)return;
    audio.src=result.audio_url; state.loadedKey=turnKey();
    audio.load(); applyPlaybackSpeed(); await audio.play();
    if(generation!==state.epoch)return;
    state.pending=false; updatePlayButton(); notice("");
  } catch(error) {
    if(generation!==state.epoch)return;
    state.playing=false; state.pending=false; updatePlayButton();
    notice(error.name==="NotAllowedError"?"配音已准备，点击播放开始。":error.message);
  }
}
$("play").onclick=async()=>{
  if(isRecording()) { notice("录音中，停止后可以播放。"); return; }
  stopPreview();
  if(state.playing) { cancelPlayback(); return; }
  if(state.loadedKey===turnKey()&&audio.getAttribute("src")&&!audio.ended) {
    $("recordedAudio").pause(); state.playing=true; updatePlayButton();
    try { applyPlaybackSpeed(); await audio.play(); notice(""); } catch(e) { cancelPlayback(); notice(e.message); }
  } else playTurn(state.turn);
};
$("previous").onclick=()=>markedMode?MarkedPractice.step(-1):playTurn(Math.max(0,state.turn-1));
$("next").onclick=()=>markedMode?MarkedPractice.step(1):playTurn(Math.min(itemTurns().length-1,state.turn+1));
$("loop").onclick=()=>{
  state.loop=!state.loop; $("loop").setAttribute("aria-pressed",String(state.loop)); save(markedMode?"markedLoop":"loop",state.loop?"1":"0");
};
$("speed").onchange=()=>{applyPlaybackSpeed();save("speed",$("speed").value);};
audio.addEventListener("ended",()=>{
  if(!state.playing)return;
  if(state.loop)playTurn(state.turn);
  else if(markedMode){state.playing=false;updatePlayButton();}
  else if(state.turn<itemTurns().length-1)playTurn(state.turn+1);
  else {
    state.playing=false;updatePlayButton();
  }
});
audio.addEventListener("timeupdate",()=>{
  const duration=Number.isFinite(audio.duration)?audio.duration:0;
  $("seek").max=duration||1;$("seek").value=audio.currentTime||0;
  $("audioTime").textContent=time(audio.currentTime)+" / "+time(duration);
});
audio.addEventListener("error",()=>{
  if(!audio.getAttribute("src"))return;
  cancelPlayback();notice("音频无法播放，请重试或检查本地配音服务。");clearAudio();
});
$("seek").oninput=()=>{if(Number.isFinite(audio.duration))audio.currentTime=Number($("seek").value);};
$("search").oninput=()=>{if(state.lesson)renderNav();};
$("sourceButton").onclick=()=>{
  if(!state.item)return;
  $("sourceTitle").textContent=state.item.book+" · 第"+state.item.page+"页";
  $("sourceImage").src=state.item.image; $("sourceDialog").showModal();
};
$("closeSource").onclick=()=>$("sourceDialog").close();
document.querySelectorAll('[name="mode"],#showRuby,#showChinese').forEach(el=>el.addEventListener("change",applyDisplay));
$("noteText").oninput=()=>{
  if(state.item)$("noteStatus").textContent=save("note:"+state.item.id,$("noteText").value)?"已保存到本机":"保存失败";
};
$("useAnswer").onclick=()=>{
  if(isRecording()||!state.item)return;cancelPlayback();clearAudio();
  if(save("answer:"+state.item.id,$("personalText").value.trim())) {
    readPersonal(state.item);state.turn=0;renderTurns();notice("个人回答已保存");
  }
};
function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("textbook-shadowing",1);
    request.onupgradeneeded=()=>{
      const store=request.result.createObjectStore("recordings",{keyPath:"id"});
      store.createIndex("exercise","exercise");
    };
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function dbRequest(mode,action) {
  const db=await state.db;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("recordings",mode);const request=action(tx.objectStore("recordings"));let result;
    request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("保存已中断"));
  });
}
async function loadTakes(id) {
  try {
    const item=state.lesson.items.find(i=>i.id===id),sources=exerciseGroup(item)?.items||[item];
    const rows=[];
    for(const source of sources) {
      const loaded=await dbRequest("readonly",store=>store.index("exercise").getAll(source.id));
      state.recordingIndex.set(source.id,new Map());loaded.forEach(indexRecording);
      state.recordingLoaded.add(source.id);rows.push(...loaded);
    }
    updateRecordingProgress();
    if(state.item.id!==id)return;
    state.takes=rows.sort((a,b)=>b.created-a.created);renderTakes();
  } catch { if(state.item?.id===id)notice("无法读取本地录音存储，请检查浏览器存储权限。"); }
}
function currentSentence() {
  const turn=itemTurns()[state.turn];if(!turn)return null;
  const settings=assignedSettings(turn);
  return {lessonId:state.lesson.id,exerciseId:state.item.id,index:state.turn,role:turn.role,text:turn.ja,
    settings:settings?{...settings}:null};
}
function takeMatches(take,sentence=currentSentence()) {
  if(!take.sentence)return take.exercise===state.item?.id;
  if(!sentence||take.sentence.lessonId!==sentence.lessonId||take.sentence.index!==sentence.index||take.sentence.role!==sentence.role)return false;
  const item=state.lesson.items.find(i=>i.id===(sentence.exerciseId||state.item?.id));
  return !take.exercise||take.exercise===item?.id||Boolean(item&&take.sentence.text===sentence.text&&sentenceSources(item,sentence.index).some(i=>i.id===take.exercise));
}
function selectedTake() {return state.takes.find(t=>t.id===$("takes").value&&takeMatches(t));}
function renderTakes() {
    const selected=$("takes").value;$("takes").replaceChildren();
    const rows=state.takes.filter(t=>takeMatches(t));
    const bound=rows.filter(t=>t.sentence),legacy=rows.filter(t=>!t.sentence);
    if(!bound.length)$("takes").append(new Option("本句暂无录音",""));
    for(const take of [...bound,...legacy]) {
      const option=document.createElement("option");option.value=take.id;
      const label=!take.sentence?"旧录音 · ":take.sentence.text!==currentSentence()?.text?"旧文本 · ":"";
      option.textContent=(window.TextbookOffline?`第 ${rows.length-rows.indexOf(take)} 次 · `:"")+label+new Date(take.created).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
      $("takes").append(option);
    }
    if(rows.some(t=>t.id===selected))$("takes").value=selected;
    else $("takes").value=bound[0]?.id||"";
    selectTake();
}
function selectTake() {
  const player=$("recordedAudio");player.pause();
  if(state.recordingUrl)URL.revokeObjectURL(state.recordingUrl);state.recordingUrl="";
  const take=selectedTake();
  if(take){state.recordingUrl=URL.createObjectURL(take.blob);player.src=state.recordingUrl;}
  else player.removeAttribute("src");
  player.load();player.hidden=!take;
  $("downloadRecording").disabled=!take;$("deleteRecording").disabled=!take;
  $("downloadRecording").hidden=!take;$("deleteRecording").hidden=!take;
  updateAnalysisEntry();
}
$("takes").onchange=selectTake;
$("recordedAudio").onplay=()=>{
  stopPreview();
  if(isRecording()){$("recordedAudio").pause();notice("请先停止录音。");return;}
  cancelPlayback();
};
$("downloadRecording").onclick=()=>{
  const take=state.takes.find(t=>t.id===$("takes").value);if(!take)return;
  const a=document.createElement("a");a.href=state.recordingUrl;
  a.download="第"+state.lesson.number+"课-"+state.item.id+"-"+take.created+"."+(take.blob.type.includes("mp4")?"m4a":"webm");a.click();
};
$("deleteRecording").onclick=async()=>{
  const id=$("takes").value;if(!id||!confirm("删除选中的这一条录音？"))return;
  const exercise=selectedTake()?.exercise,viewId=state.item.id;
  try{
    await dbRequest("readwrite",store=>store.delete(id));
    state.recordingIndex.get(exercise)?.delete(id);updateRecordingProgress();
    await loadTakes(viewId);notice("录音已删除");
  }
  catch{notice("删除失败，录音仍保留。");}
};
function renderUnmatchedRecordings() {
  const list=$("unmatchedList");list.replaceChildren();
  if(state.recordingIndexStatus!=="ready") {
    $("unmatchedStatus").textContent="无法完整读取录音，请重试。";return;
  }
  const rows=unmatchedRecordings();
  $("unmatchedStatus").textContent=rows.length?`${rows.length} 条未对应录音`:"没有未对应的录音";
  for(const take of rows) {
    const item=state.lesson.items.find(i=>i.id===take.exercise);
    const row=document.createElement("div");row.className="unmatched-row";row.dataset.take=take.id;
    const content=document.createElement("div"),title=document.createElement("p"),meta=document.createElement("small");
    title.textContent=take.sentence?.text||item?.title||"未关联句子的录音";
    const date=Number.isFinite(take.created)?new Date(take.created).toLocaleString("zh-CN"):"时间未记录";
    meta.textContent=date+" · "+(item?item.book+" "+item.page+"页 · "+item.number:"原练习不存在");
    content.append(title,meta);
    const button=document.createElement("button");button.className="icon-button delete-unmatched";
    button.title="删除这条录音";button.setAttribute("aria-label","删除这条录音");
    const icon=document.createElement("i");icon.dataset.lucide="trash-2";button.append(icon);
    button.onclick=async()=>{
      if(!confirm("永久删除这条未对应录音？此操作无法撤销。"))return;
      button.disabled=true;
      try {
        await deleteUnmatchedRecording(take.id);
        state.recordingIndex.get(take.exercise)?.delete(take.id);updateRecordingProgress();
        if(state.item?.id===take.exercise)await loadTakes(take.exercise);
        renderUnmatchedRecordings();
      } catch(e) {button.disabled=false;$("unmatchedStatus").textContent=e.message||"删除失败，录音仍保留。";}
    };
    row.append(content,button);list.append(row);
  }
  icons();
}
async function deleteUnmatchedRecording(id) {
  const db=await state.db;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("recordings","readwrite"),store=tx.objectStore("recordings");
    const request=store.get(id);let reason="删除失败，录音仍保留。";
    request.onsuccess=()=>{
      if(!request.result)return;
      const take=recordingMetadata(request.result),item=state.lesson.items.find(i=>i.id===take.exercise);
      // Recheck in the delete transaction in case a pending analysis just linked this take.
      if(!isLessonRecording(take)||recordingTurn(take,item)>=0) {
        reason="录音的关联已更新，未删除。请刷新列表。";tx.abort();return;
      }
      store.delete(id);
    };
    tx.oncomplete=resolve;tx.onerror=()=>reject(new Error(reason));tx.onabort=()=>reject(new Error(reason));
  });
}
async function openUnmatchedRecordings() {
  if(isRecording()){notice("请先停止录音，再管理录音。");return;}
  if(!$("unmatchedDialog").open)$("unmatchedDialog").showModal();
  $("unmatchedList").replaceChildren();$("unmatchedStatus").textContent="正在读取录音…";
  $("refreshUnmatched").disabled=true;
  await loadRecordingIndex();$("refreshUnmatched").disabled=false;
  if($("unmatchedDialog").open)renderUnmatchedRecordings();
}
$("manageUnmatched").onclick=openUnmatchedRecordings;
$("refreshUnmatched").onclick=openUnmatchedRecordings;
$("closeUnmatched").onclick=()=>$("unmatchedDialog").close();
function updateAnalysisEntry() {
  const take=selectedTake(),button=$("analyzeRecording");
  if(window.TextbookOffline){button.hidden=true;return;}
  button.disabled=!currentSentence()||!take||isRecording();
  button.title=isRecording()?"停止录音后查看分析":!take?"请先录制当前句，或选择已有录音":"分析当前句和所选录音";
  button.querySelector("span").textContent=take?.analysis?"查看分析":"跟读分析";
}
function analysisKey(sentence) {
  return JSON.stringify(["textbook-analysis-v1",sentence.lessonId,sentence.index,sentence.role,sentence.text,
    sentence.settings?settingsKey(sentence.settings):null]);
}
async function persistTakeAnalysis(take,sentence,analysis) {
  const db=await state.db;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("recordings","readwrite"),store=tx.objectStore("recordings");let saved=false;
    const get=store.get(take.id);
    get.onsuccess=()=>{
      // A recording deleted while recognition was running must never be restored.
      if(!get.result)return;
      store.put({...get.result,sentence,analysis});saved=true;
    };
    tx.oncomplete=()=>resolve(saved);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
function showAnalysisResult() {
  const view=state.analysisView;
  if(!$("analysisDialog").open||!view?.analysis||!state.analysisFrameReady)return;
  $("analysisFrame").hidden=false;
  $("analysisFrame").contentWindow.postMessage({type:"textbook-analysis-result",target:view.sentence.text,
    recordingBlob:view.take.blob,reference:view.analysis.reference,result:view.analysis.result},location.origin);
}
window.addEventListener("message",event=>{
  if(event.origin!==location.origin||event.source!==$("analysisFrame").contentWindow||!$("analysisDialog").open)return;
  if(event.data?.type==="textbook-analysis-ready") {state.analysisFrameReady=true;showAnalysisResult();}
});
async function runSentenceAnalysis(force=false) {
  const view=state.analysisView;if(!view)return;
  const generation=++state.analysisEpoch,key=analysisKey(view.sentence),workKey=view.take.id+key;
  $("retryAnalysis").hidden=true;$("analysisFrame").hidden=true;
  $("analysisStatus").textContent="正在准备本句的标准配音…";
  try {
    let analysis=!force&&view.take.analysis?.key===key?view.take.analysis:null;
    let saved=true;
    if(!analysis) {
      if(!state.analysisWork.has(workKey)) {
        const pending=(async()=>{
          const reference=await audioFor({role:view.sentence.role,ja:view.sentence.text},view.sentence.settings);
          if(!reference.filename||!reference.audio_url)throw new Error("标准音频信息不完整，请重试。");
          if(state.analysisView===view&&$("analysisDialog").open)$("analysisStatus").textContent="正在本机识别并分析音频…";
          const form=new FormData();
          const extension=view.take.blob.type.includes("mp4")?"m4a":view.take.blob.type.includes("wav")?"wav":"webm";
          form.append("audio",view.take.blob,"recording."+extension);
          form.append("target",view.sentence.text);form.append("reference_filename",reference.filename);
          const response=await fetch("/api/transcribe",{method:"POST",body:form});
          const result=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"本机分析失败，请重试。");
          const analysis={key,reference,result,created:Date.now()};
          let saved=false;try{saved=await persistTakeAnalysis(view.take,view.sentence,analysis);}catch{}
          if(saved) {
            const stored=state.takes.find(t=>t.id===view.take.id);
            if(stored){stored.analysis=analysis;stored.sentence=view.sentence;}
            view.take.analysis=analysis;view.take.sentence=view.sentence;
            indexRecording(view.take);updateRecordingProgress();
          }
          updateAnalysisEntry();return {analysis,saved};
        })();
        state.analysisWork.set(workKey,pending);
        pending.finally(()=>state.analysisWork.delete(workKey)).catch(()=>{});
      }
      ({analysis,saved}=await state.analysisWork.get(workKey));
    }
    if(generation!==state.analysisEpoch||state.analysisView!==view||!$("analysisDialog").open)return;
    view.analysis=analysis;showAnalysisResult();
    const warning=analysis.result.audio_data?.available?"":" 音频曲线暂不可用。";
    $("analysisStatus").textContent=(saved?"分析结果已保存在本机。":"分析完成，但本机保存失败；原始录音未改动。")+warning;
    $("retryAnalysis").hidden=false;
  } catch(e) {
    if(generation!==state.analysisEpoch||state.analysisView!==view||!$("analysisDialog").open)return;
    $("analysisStatus").textContent=e.message;$("retryAnalysis").hidden=false;
  }
}
$("analyzeRecording").onclick=()=>{
  const take=selectedTake(),current=currentSentence();if(!take||!current||isRecording())return;
  if(!take.sentence&&!confirm("这条旧录音没有句子关联信息。确认它是当前第 "+(current.index+1)+" 句的跟读录音吗？\n"+current.text))return;
  if(take.sentence&&take.sentence.text!==current.text&&!confirm("这条录音对应修改前的文本，将按下面的原句分析。继续吗？\n"+take.sentence.text))return;
  const sentence={...(take.sentence||current)};
  if(!sentence.settings)sentence.settings=current.settings;
  cancelPlayback();stopPreview();$("recordedAudio").pause();
  state.analysisView={take,sentence};state.analysisFrameReady=false;
  $("analysisTitle").textContent="第 "+(sentence.index+1)+" 句 · 跟读分析";
  $("analysisContext").textContent="第 "+state.lesson.number+" 课 / "+state.item.title+" / "+sentence.role;
  $("analysisSentence").textContent=sentence.text;
  const voice=state.voices.find(v=>v.style_id===sentence.settings?.style_id);
  $("analysisReference").textContent="标准配音："+(voice?voice.speaker_name+" · "+styleLabel(voice.style_name):"原角色音色")+
    " · "+new Date(take.created).toLocaleString("zh-CN")+" 的录音";
  $("analysisFrame").hidden=true;$("analysisFrame").src="index.html?textbook-result=1&v=sentence-analysis-1";
  $("analysisDialog").showModal();runSentenceAnalysis();
};
$("retryAnalysis").onclick=()=>runSentenceAnalysis(true);
function closeSentenceAnalysis() {
  state.analysisEpoch++;state.analysisView=null;state.analysisFrameReady=false;
  $("analysisFrame").src="about:blank";$("analysisFrame").hidden=true;
  $("analysisDialog").close();
}
$("closeAnalysis").onclick=closeSentenceAnalysis;
$("analysisDialog").addEventListener("cancel",event=>{event.preventDefault();closeSentenceAnalysis();});
$("analysisDialog").addEventListener("close",()=>{
  if(!$("analysisDialog").open&&state.analysisView)closeSentenceAnalysis();
});
function setRecordingMeter(status,level=0,decibels=-80) {
  const labels={idle:"未录音",silent:"等待声音",quiet:"声音偏小",normal:"有声音",loud:"接近峰值",unavailable:"音量不可用"};
  $("recordMeter").dataset.state=status;$("recordMeterText").textContent=labels[status];
  $("recordMeterLevel").style.transform=`scaleX(${level/100})`;
  $("recordMeterBar").setAttribute("aria-valuenow",String(Math.round(decibels)));
  $("recordMeterBar").setAttribute("aria-valuetext",labels[status]);
}
function stopRecordingMeter() {
  const meter=state.recordingMeter;state.recordingMeter=null;
  if(meter) {
    cancelAnimationFrame(meter.frame);
    meter.source?.disconnect();meter.analyser?.disconnect();
    if(meter.context&&meter.context.state!=="closed")meter.context.close().catch(()=>{});
  }
  setRecordingMeter("idle");
}
function startRecordingMeter(stream,recorder) {
  stopRecordingMeter();
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass){setRecordingMeter("unavailable");return;}
  const meter={context:null,source:null,analyser:null,frame:0,lastUpdate:-Infinity,loudUntil:0};
  const unavailable=()=>{
    if(state.recordingMeter!==meter)return;
    stopRecordingMeter();setRecordingMeter("unavailable");
  };
  state.recordingMeter=meter;
  try {
    meter.context=new AudioContextClass();
    meter.source=meter.context.createMediaStreamSource(stream);
    meter.analyser=meter.context.createAnalyser();meter.analyser.fftSize=2048;
    // Observe the existing microphone stream without monitoring it through speakers or altering the recorder input.
    meter.source.connect(meter.analyser);
    const samples=new Float32Array(meter.analyser.fftSize);
    setRecordingMeter("silent");meter.context.resume().catch(unavailable);
    const update=now=>{
      if(state.recordingMeter!==meter||recorder.state!=="recording")return;
      if(now-meter.lastUpdate>=50) {
        meter.lastUpdate=now;
        try {
          meter.analyser.getFloatTimeDomainData(samples);
          let sum=0,peak=0;
          for(const sample of samples){sum+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
          const rms=Math.sqrt(sum/samples.length),db=Math.max(-80,Math.min(0,rms>0?20*Math.log10(rms):-80));
          const level=Math.max(0,Math.min(100,(db+58)/46*100));
          if(peak>=.98)meter.loudUntil=now+250;
          setRecordingMeter(now<meter.loudUntil?"loud":db< -48?"silent":db< -32?"quiet":"normal",level,db);
        } catch {unavailable();return;}
      }
      meter.frame=requestAnimationFrame(update);
    };
    meter.frame=requestAnimationFrame(update);
  } catch {unavailable();}
}
async function startRecording() {
  if(!state.item)return;
  const sentence=currentSentence();if(!sentence){notice("请先选择可跟读的句子。");return;}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){notice("当前浏览器不支持录音，请用本机浏览器打开。");return;}
  cancelPlayback();$("recordedAudio").pause();state.recordingPending=true;$("record").disabled=true;updateAnalysisEntry();
  const viewId=state.item.id,sources=sentenceSources(state.item,state.turn),exercise=sources[0].id;
  let desktopTicket;
  try {
    desktopTicket=await window.desktopSession?.begin();
    await state.db;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    state.stream=stream;
    const type=["audio/mp4","audio/webm;codecs=opus","audio/webm"].find(t=>MediaRecorder.isTypeSupported(t));
    const recorder=type?new MediaRecorder(stream,{mimeType:type}):new MediaRecorder(stream);
    state.recorder=recorder;const chunks=[];const started=Date.now();
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onstop=async()=>{
      stopRecordingMeter();
      stream.getTracks().forEach(t=>t.stop());state.stream=null;state.recorder=null;clearInterval(state.recordTimer);
      $("record").classList.remove("is-recording");setIcon($("record"),"mic","开始录音");
      $("record").disabled=false;state.recordingPending=false;
      const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0]?.type||"audio/webm"});
      if(!blob.size){notice("录音为空，请重试。");updateAnalysisEntry();await window.desktopSession?.end(desktopTicket);return;}
      state.recordingSaving=true;$("record").disabled=true;
      try {
        const id=crypto.randomUUID();
        const take={id,exercise,sentence,created:Date.now(),blob};
        if(window.TextbookOffline){
          const db=await state.db;
          await new Promise((resolve,reject)=>{
            const tx=db.transaction("recordings","readwrite"),store=tx.objectStore("recordings");
            let remaining=sources.length;const previous=[];
            for(const source of sources) {
              const request=store.index("exercise").getAll(source.id);
              request.onsuccess=()=>{
                previous.push(...request.result);if(--remaining)return;
                const matches=previous.filter(old=>old.sentence&&takeMatches(old,sentence)).sort((a,b)=>b.created-a.created);
                // Keep the original identity so desktop round-trip sync replaces the same take.
                if(matches.length){take.id=matches[0].id;take.exercise=matches[0].exercise;}
                for(const old of matches)if(old.id!==take.id)store.delete(old.id);
                store.put(take);
              };
            }
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("录音未保存"));
          });
        }else await dbRequest("readwrite",store=>store.put(take));
        indexRecording(take);updateRecordingProgress();
        await loadTakes(viewId);
        if(state.item.id===viewId&&takeMatches({sentence})){$("takes").value=take.id;selectTake();}
        notice(window.TextbookOffline?"本句录音已保存，重录会替换。":"第 "+(sentence.index+1)+" 句录音已保存，可查看跟读分析");
      } catch {
        const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;
        a.download="未保存的录音."+(blob.type.includes("mp4")?"m4a":"webm");a.click();
        setTimeout(()=>URL.revokeObjectURL(url),60000);notice("本地保存失败，已尝试下载备份，请确认下载成功。");
      } finally {
        state.recordingSaving=false;$("record").disabled=false;
        await window.desktopSession?.end(desktopTicket);
      }
      updateAnalysisEntry();
    };
    recorder.onerror=()=>{
      window.desktopSession?.end(desktopTicket);
      stopRecordingMeter();
      stream.getTracks().forEach(t=>t.stop());clearInterval(state.recordTimer);
      state.recorder=null;state.stream=null;state.recordingPending=false;
      $("record").disabled=false;$("record").classList.remove("is-recording");setIcon($("record"),"mic","开始录音");
      notice("录音中断，请重试。");
      updateAnalysisEntry();
    };
    recorder.start();state.recordingPending=false;$("record").disabled=false;$("record").classList.add("is-recording");
    startRecordingMeter(stream,recorder);
    setIcon($("record"),"square","停止录音");$("recordTime").textContent="0:00";
    state.recordTimer=setInterval(()=>{$("recordTime").textContent=time((Date.now()-started)/1000);},250);
    notice("正在录音…");
  } catch(e) {
    await window.desktopSession?.end(desktopTicket);
    stopRecordingMeter();
    state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;state.recordingPending=false;$("record").disabled=false;
    notice(e.name==="NotAllowedError"?"麦克风权限未获允许，请在浏览器设置中允许录音。":"无法开始录音："+e.message);
    updateAnalysisEntry();
  }
}
$("record").onclick=()=>{
  stopPreview();
  if(state.recorder?.state==="recording") {
    stopRecordingMeter();
    state.recordingPending=true;$("record").disabled=true;state.recorder.stop();
    state.stream?.getTracks().forEach(t=>t.stop());
  } else if(!isRecording())startRecording();
};
window.addEventListener("beforeunload",event=>{if(isRecording()){event.preventDefault();event.returnValue="";}});
window.addEventListener("pagehide",()=>{stopRecordingMeter();clearInterval(state.recordTimer);state.stream?.getTracks().forEach(t=>t.stop());});
const synthesisFields=[
  {id:"synthesisSpeed",key:"speed",min:.5,max:2,step:.05,default:1},
  {id:"emotion",key:"emotion",min:0,max:2,step:.05,default:1},
  {id:"tempo",key:"tempo",min:0,max:2,step:.05,default:1},
  {id:"pitch",key:"pitch",min:-.15,max:.15,step:.01,default:0}
];
function styleLabel(name) {
  const labels={"ノーマル":"普通","ふつー":"平常","あまあま":"甜美","おちつき":"沉稳","からかい":"打趣","せつなめ":"伤感","ねむたい":"困倦","上機嫌":"开心","Calm":"沉稳","close":"近距离","close-shout":"近距离喊话","far":"远距离","far-shout":"远距离喊话","Far":"远距离","Heavy":"厚重","Mid":"中等","Shout":"喊话","Surprise":"惊讶"};
  return labels[name]?labels[name]+"（"+name+"）":name;
}
function speakerKey(voice) { return voice.speaker_uuid||voice.speaker_name; }
function selectedVoice() { return state.voices.find(v=>String(v.style_id)===$("voice").value); }
function normalizeSettings(raw,voice) {
  const result={style_id:voice.style_id};
  for(const field of synthesisFields) {
    const value=raw?.[field.key];
    result[field.key]=Number.isFinite(value)&&value>=field.min&&value<=field.max?
      Number((Math.round(value/field.step)*field.step).toFixed(2)):field.default;
  }
  if(!voice.emotion_supported)result.emotion=1;
  return result;
}
function updateVoiceSummary() {
  const settings=state.item?assignedSettings():state.synthesis;
  const voice=state.voices.find(v=>v.style_id===settings?.style_id);
  const role=itemTurns()[state.turn]?.role;
  const label=(role?role+"：":"")+(voice?voice.speaker_name+" · "+styleLabel(voice.style_name):"音色不可用");
  $("voiceSummary").textContent=label;$("voiceSettings").title="配音设置："+label;
}
function updateEmotionState() {
  const enabled=Boolean(selectedVoice()?.emotion_supported);
  $("emotion").disabled=$("emotionValue").disabled=!enabled;
  $("emotionStatus").textContent=enabled?"":"普通风格自动处理";
  if(!enabled){$("emotion").value=1;$("emotionValue").value="1.00";}
}
function renderStyles(preferred) {
  const voices=state.voices.filter(v=>speakerKey(v)===$("speaker").value);
  $("voice").replaceChildren(...voices.map(v=>new Option(styleLabel(v.style_name),v.style_id)));
  if(voices.some(v=>v.style_id===preferred))$("voice").value=String(preferred);
  updateEmotionState();
}
function fillVoiceForm(settings) {
  const voice=state.voices.find(v=>v.style_id===settings.style_id);
  for(const field of synthesisFields){$(field.id).value=settings[field.key];$(field.id+"Value").value=settings[field.key].toFixed(2);}
  if(voice){$("speaker").value=speakerKey(voice);renderStyles(voice.style_id);}
  else {
    $("speaker").value="";$("voice").replaceChildren(new Option("音色未安装",""));updateEmotionState();
    $("voiceNotice").textContent="该角色保存的音色或风格未安装，请重新选择或使用默认配音。";
  }
  $("pitchWarning").hidden=settings.pitch===0;
}
function draftSettings() {
  if(!$("voiceForm").reportValidity())return null;
  const voice=selectedVoice();if(!voice){$("voiceNotice").textContent="请选择已安装的音色和风格。";return null;}
  return normalizeSettings(Object.fromEntries(synthesisFields.map(f=>[f.key,Number($(f.id+"Value").value)])),voice);
}
function stopPreview() {
  state.previewEpoch++;state.previewing=false;$("voicePreview").pause();
  $("previewVoice").setAttribute("aria-busy","false");
  $("previewVoice").querySelector("span").textContent=state.voiceDraft?.role?"试听角色":"试听当前句";
}
function draftChanged() {stopPreview();$("voiceNotice").textContent="";}
function draftVoiceProfile() {
  const d=state.voiceDraft;
  return d.scope==="common"?d.profiles.common:d.profiles.lessons[d.lessonId];
}
function voiceRoster() {
  if(state.voiceDraft.scope==="lesson")return lessonRoles();
  const roles=new Map();
  for(const lesson of state.lessons)for(const [name,items] of lessonRoles(lesson)) {
    const role=commonRoleKey(name);if(!roles.has(role))roles.set(role,[]);
    roles.get(role).push(...items);
  }
  for(const role of Object.keys(state.voiceDraft.profiles.common.overrides))if(!roles.has(role))roles.set(role,[]);
  return roles;
}
function draftAssignedSettings(role=state.voiceDraft.role) {
  const d=state.voiceDraft,p=draftVoiceProfile();
  if(!role)return p.defaultSettings||d.profiles.common.defaultSettings;
  return p.overrides[role]||commonSettings(d.profiles,role,p.defaultSettings);
}
function clearLegacyVoice(profile,role) {
  if(profile.legacyRoles)profile.legacyRoles=profile.legacyRoles.filter(r=>r!==role);
  if(profile.conflicts)delete profile.conflicts[role];
}
function captureVoiceTarget() {
  const draft=state.voiceDraft;if(!draft)return false;
  const profile=draftVoiceProfile();
  if(!$("inheritVoiceLabel").hidden&&$("inheritVoice").checked) {
    if(draft.role){delete profile.overrides[draft.role];clearLegacyVoice(profile,draft.role);}
    else profile.defaultSettings=null;
    return true;
  }
  const settings=draftSettings();if(!settings)return false;
  if(draft.role){profile.overrides[draft.role]=settings;clearLegacyVoice(profile,draft.role);}
  else profile.defaultSettings=settings;
  return true;
}
function renderVoiceRoster() {
  const draft=state.voiceDraft;if(!draft)return;
  const profile=draftVoiceProfile(),common=draft.scope==="common",defaultName=common?"通用默认配音":"本课默认配音";
  $("voiceRoles").replaceChildren();
  for(const [role,items] of [["",[]],...voiceRoster()]) {
    const button=document.createElement("button");button.type="button";button.dataset.role=role;
    button.setAttribute("aria-pressed",String(draft.role===role));
    const name=document.createElement("strong");name.textContent=role||defaultName;
    const assigned=role?Object.hasOwn(profile.overrides,role):Boolean(profile.defaultSettings);
    const settings=draftAssignedSettings(role);
    const voice=state.voices.find(v=>v.style_id===settings.style_id);
    const summary=document.createElement("span");
    summary.textContent=(common?assigned?"":"默认 · ":assigned?"本课特殊 · ":"继承 · ")+(voice?voice.speaker_name+" · "+styleLabel(voice.style_name):"音色未安装");
    button.title=(role||defaultName)+"："+summary.textContent;
    button.append(name,summary);
    if(items.length) {
      const count=document.createElement("small");count.textContent=items.length+" 个练习";
      if(profile.conflicts?.[role])count.textContent+=" · 原有 "+profile.conflicts[role]+" 套配音";
      button.append(count);
    }
    button.onclick=()=>{
      if(draft.role===role||!captureVoiceTarget())return;
      draftChanged();draft.role=role;renderVoiceTarget();
      Array.from($("voiceRoles").children).find(b=>b.dataset.role===role)?.focus({preventScroll:true});
    };
    $("voiceRoles").append(button);
  }
}
function renderVoiceTarget() {
  const draft=state.voiceDraft;if(!draft)return;
  const profile=draftVoiceProfile(),common=draft.scope==="common";
  const inherited=draft.role?!Object.hasOwn(profile.overrides,draft.role):!profile.defaultSettings;
  $("inheritVoiceLabel").hidden=common&&!draft.role;$("inheritVoice").checked=inherited;
  $("inheritVoiceText").textContent=common||!draft.role?"使用通用默认配音":"使用通用配音";
  $("voiceParameters").disabled=inherited;$("resetVoice").disabled=inherited;
  $("voiceRoleName").textContent=draft.role||(common?"通用默认配音":"本课默认配音");
  $("voiceScope").textContent=draft.role?
    (common?"跨课程通用":"仅第 "+state.lesson.number+" 课")+" · "+(voiceRoster().get(draft.role)?.length||0)+" 个练习":
    common?"所有课程的默认声音":"本课没有角色专属配音时使用";
  $("commonVoiceTab").setAttribute("aria-pressed",String(common));
  $("lessonVoiceTab").setAttribute("aria-pressed",String(!common));
  $("useCommonVoices").hidden=common;$("promoteVoice").hidden=common||inherited;
  $("voiceRoles").setAttribute("aria-label",common?"跨课程全部配音角色":"本课全部配音角色");
  $("voiceLesson").textContent=common?"通用配音 · "+voiceRoster().size+" 个角色":
    "第 "+state.lesson.number+" 课 · "+state.lesson.title+" · "+lessonRoles().size+" 个角色";
  const sample=previewSample();
  $("voiceSample").textContent=sample.turn?.ja||"暂无可试听台词";
  $("voiceSampleSource").textContent=sample.turn?"第 "+sample.lesson.number+" 课 · "+sample.item.book+" · "+sample.item.page+"页 · "+sample.item.title:"";
  const conflicts=Object.keys(profile.conflicts||{});
  $("voiceNotice").textContent=profile.conflicts?.[draft.role]?
    "该角色原有 "+profile.conflicts[draft.role]+" 套配音；应用后，本课统一使用当前所选设置。":
    !draft.role&&conflicts.length?"存在多套旧配音："+conflicts.join("、")+"。请逐项确认后应用。":"";
  fillVoiceForm(draftAssignedSettings());
  $("previewVoice").disabled=!previewTurn();
  $("previewVoice").querySelector("span").textContent=draft.role?"试听角色":"试听当前句";
  renderVoiceRoster();
}
$("inheritVoice").onchange=()=>{
  const draft=state.voiceDraft;if(!draft)return;draftChanged();
  const profile=draftVoiceProfile(),settings={...draftAssignedSettings()};
  if(draft.role) {
    if($("inheritVoice").checked)delete profile.overrides[draft.role];
    else profile.overrides[draft.role]=settings;
    clearLegacyVoice(profile,draft.role);
  } else profile.defaultSettings=$("inheritVoice").checked?null:settings;
  renderVoiceTarget();
};
function switchVoiceScope(scope) {
  const draft=state.voiceDraft;if(!draft||scope===draft.scope||!captureVoiceTarget())return;
  draftChanged();draft.scope=scope;
  if(scope==="common")draft.role=commonRoleKey(draft.role);
  else if(!lessonRoles().has(draft.role))draft.role=[...lessonRoles().keys()].find(r=>commonRoleKey(r)===draft.role)||"";
  renderVoiceTarget();
}
$("commonVoiceTab").onclick=()=>switchVoiceScope("common");
$("lessonVoiceTab").onclick=()=>switchVoiceScope("lesson");
$("useCommonVoices").onclick=()=>{
  const d=state.voiceDraft;if(!d||d.scope!=="lesson")return;
  draftChanged();d.profiles.lessons[d.lessonId]=emptyLessonVoice();renderVoiceTarget();
};
$("promoteVoice").onclick=()=>{
  const d=state.voiceDraft;if(!d||d.scope!=="lesson"||!captureVoiceTarget())return;
  const profile=draftVoiceProfile(),settings={...draftAssignedSettings()};
  if(d.role) {
    d.profiles.common.overrides[commonRoleKey(d.role)]=settings;
    delete profile.overrides[d.role];clearLegacyVoice(profile,d.role);
  } else {d.profiles.common.defaultSettings=settings;profile.defaultSettings=null;}
  draftChanged();renderVoiceTarget();
};
for(const field of synthesisFields) {
  $(field.id).oninput=()=>{
    $(field.id+"Value").value=Number($(field.id).value).toFixed(2);draftChanged();
    $("pitchWarning").hidden=Number($("pitch").value)===0;
  };
  $(field.id+"Value").oninput=()=>{
    if($(field.id+"Value").validity.valid)$(field.id).value=$(field.id+"Value").value;
    draftChanged();$("pitchWarning").hidden=Number($("pitchValue").value)===0;
  };
}
$("speaker").onchange=()=>{draftChanged();renderStyles();};
$("voice").onchange=()=>{draftChanged();updateEmotionState();};
$("voiceSettings").onclick=()=>{
  if(!state.synthesis)return;
  const profiles=structuredClone(voiceProfiles());
  profiles.lessons[state.lesson.id]||=emptyLessonVoice();
  state.voiceDraft={role:"",scope:"common",lessonId:state.lesson.id,profiles,stored:read("voiceProfiles:v2")};
  $("voiceNotice").textContent="";renderVoiceTarget();$("voiceDialog").showModal();
};
$("closeVoice").onclick=()=>$("voiceDialog").close();
$("voiceDialog").addEventListener("close",()=>{state.voiceDraft=null;stopPreview();});
$("resetVoice").onclick=()=>{
  const voice=selectedVoice();if(!voice)return;draftChanged();fillVoiceForm(normalizeSettings({},voice));
};
$("voiceForm").onsubmit=event=>{
  event.preventDefault();if(!captureVoiceTarget())return;
  const draft=state.voiceDraft;
  if(read("voiceProfiles:v2")!==draft.stored) {
    $("voiceNotice").textContent="另一页面已更新配音。请关闭后重新打开设置，再修改。";return;
  }
  const before=JSON.stringify(assignedSettings());
  if(!save("voiceProfiles:v2",JSON.stringify(draft.profiles))) {
    $("voiceNotice").textContent="本机保存失败，配音设置未更改。请清理存储后重试。";return;
  }
  state.voiceProfiles=draft.profiles;
  if(before!==JSON.stringify(assignedSettings())){cancelPlayback();clearAudio();}
  updateVoiceSummary();notice("通用配音与本课特殊设置已保存。");
  $("voiceDialog").close();
};
window.addEventListener("storage",event=>{
  if(event.key!==prefix+"voiceProfiles:v2"||!state.synthesis)return;
  const before=JSON.stringify(assignedSettings());state.voiceProfiles=null;
  if(before!==JSON.stringify(assignedSettings())){cancelPlayback();clearAudio();}
  updateVoiceSummary();
});
$("previewVoice").onclick=async()=>{
  if(state.previewing){stopPreview();$("voiceNotice").textContent="";return;}
  if(isRecording()){$("voiceNotice").textContent="请先停止录音。";return;}
  if(!captureVoiceTarget())return;
  const draft=state.voiceDraft,turn=previewTurn();if(!turn)return;
  const settings=draftAssignedSettings();
  cancelPlayback();$("recordedAudio").pause();stopPreview();
  const generation=state.previewEpoch;state.previewing=true;
  $("previewVoice").querySelector("span").textContent="停止试听";
  $("previewVoice").setAttribute("aria-busy","true");$("voiceNotice").textContent="正在生成试听…";
  try {
    const preview=$("voicePreview"),key=JSON.stringify([turn.ja,settings]);
    if(state.previewKey!==key||!preview.getAttribute("src")) {
      const result=await audioFor(turn,settings);
      if(generation!==state.previewEpoch)return;
      preview.src=result.audio_url;state.previewKey=key;
    }
    preview.currentTime=0;preview.playbackRate=1;
    await preview.play();if(generation!==state.previewEpoch)return;
    $("previewVoice").setAttribute("aria-busy","false");$("voiceNotice").textContent="";
  } catch(e) {
    if(generation!==state.previewEpoch)return;stopPreview();
    $("voiceNotice").textContent=e.name==="NotAllowedError"?"试听已准备，请再点一次试听。":e.message;
  }
};
$("voicePreview").addEventListener("ended",stopPreview);
$("voicePreview").addEventListener("error",()=>{stopPreview();$("voiceNotice").textContent="试听音频无法播放，请重试。";});
async function loadVoices() {
  try {
    const data=await api("/api/textbook/voices");state.voices=data.voices;$("speaker").replaceChildren();
    const seen=new Set();
    for(const voice of data.voices) {
      const key=speakerKey(voice);if(seen.has(key))continue;seen.add(key);
      $("speaker").append(new Option(voice.speaker_name,key));
    }
    let stored;try{stored=JSON.parse(read("synthesis","null"));}catch{}
    const preferred=state.synthesis||stored||{style_id:Number(read("voice",String(data.default_style_id)))};
    const voice=data.voices.find(v=>v.style_id===preferred.style_id)||data.voices.find(v=>v.style_id===data.default_style_id)||data.voices[0];
    const settings=voice?normalizeSettings(preferred,voice):null;
    if(state.synthesis&&JSON.stringify(settings)!==JSON.stringify(state.synthesis)){cancelPlayback();clearAudio();}
    state.synthesis=settings;if(settings)fillVoiceForm(settings);updateVoiceSummary();
    $("voiceSettings").disabled=!voice||Boolean(window.TextbookOffline);
    $("engineStatus").textContent=window.TextbookOffline?"离线教材":data.voices.length?"本地配音已连接":"未安装音色";
    $("play").disabled=!itemTurns().length||!state.voices.length;
  } catch {
    state.voices=[];$("voiceSettings").disabled=true;
    $("engineStatus").textContent="配音未连接 · 重试";$("play").disabled=true;
    notice("请启动本机 AivisSpeech，然后点击顶部连接状态重试。");
  }
}
$("engineStatus").onclick=loadVoices;
$("navToggle").onclick=()=>{
  const open=document.body.classList.toggle("nav-open");$("navToggle").setAttribute("aria-expanded",String(open));
};
function courseUrl(entry,item="") {
  const url=new URL(location.href);url.searchParams.set("lesson",String(entry.number).padStart(2,"0"));
  url.searchParams.delete("turn");url.hash=item;return url;
}
function changeLesson(entry,item="") {
  if(!entry||entry.id===state.lesson?.id)return;
  if(isRecording()) {
    $("lessonSelect").value=String(state.lesson.number);
    history.replaceState(null,"",courseUrl(state.lesson,state.item.id));
    notice("请先结束录音并保存，再切换课程。");return;
  }
  stopPreview();cancelPlayback();$("recordedAudio").pause();
  if($("analysisDialog").open)closeSentenceAnalysis();
  // A document navigation also disposes of old TTS, reading and preview callbacks.
  location.assign(courseUrl(entry,item));
}
$("lessonSelect").onchange=()=>{
  if(markedMode){MarkedPractice.filter();return;}
  changeLesson(state.catalog.find(l=>String(l.number)===$("lessonSelect").value));
};
$("markedPracticeLink").onclick=event=>{
  if(isRecording()){event.preventDefault();notice("请先结束录音并保存，再打开标记练习。");}
};
window.addEventListener("hashchange",()=>{
  if(markedMode)return;
  if(!state.lesson)return;
  const {entry,hash}=routeLesson(state.catalog);
  if(entry.id!==state.lesson.id) {changeLesson(entry,hash);return;}
  if(isRecording()) {
    history.replaceState(null,"",courseUrl(state.lesson,state.item.id));
    notice("请先停止录音，再切换练习。");return;
  }
  if(hash!==state.item?.id)selectItem(hash);
});
function routeLesson(catalog) {
  const url=new URL(location.href);
  let hash="";try{hash=decodeURIComponent(url.hash.slice(1));}catch{}
  const requested=url.searchParams.get("lesson");
  const fromHash=/^l(\d{2})-/.exec(hash);
  const number=requested!==null?Number(requested):hash?(fromHash?Number(fromHash[1]):1):Number(read("lastLesson","1"));
  return {entry:catalog.find(l=>l.number===number)||catalog[0],hash};
}
async function init() {
  if(markedMode&&new URL(location.href).searchParams.get("view")==="manage") {
    location.replace((window.TextbookOffline?"mobile-textbook-tags-manage.html":"textbook-tags-manage.html")+"?view=manage");return;
  }
  icons();state.db=openDB();state.db.catch(()=>{});
  new ResizeObserver(()=>{
    document.documentElement.style.setProperty("--panel-height",document.querySelector(".playback-panel").offsetHeight+"px");
  }).observe(document.querySelector(".playback-panel"));
  try {
    const getCourse=window.TextbookOffline?TextbookOffline.fetch:fetch;
    const catalogResponse=await getCourse("textbook-lessons.json?v=lessons-1-15-1");
    if(!catalogResponse.ok)throw new Error("课程目录加载失败，请刷新重试。");
    state.catalog=(await catalogResponse.json()).lessons;
    if(!state.catalog.length){location.replace("mobile-textbook-library.html");return;}
    const {entry,hash}=routeLesson(state.catalog);
    $("lessonSelect").replaceChildren(...state.catalog.map(l=>new Option("第 "+l.number+" 课 · "+l.title,String(l.number))));
    $("lessonSelect").value=String(entry.number);
    const response=await getCourse(entry.file+"?v=lessons-1-15-1");if(!response.ok)throw new Error("第"+entry.number+"课内容加载失败");
    const lesson=await response.json();
    if(lesson.id!==entry.id||!Array.isArray(lesson.items)||!lesson.items.length)throw new Error("课程内容不完整，请刷新重试。");
    state.lesson=lesson;
    state.lessons=await Promise.all(state.catalog.map(async entry=>{
      if(entry.id===lesson.id)return lesson;
      const r=await getCourse(entry.file+"?v=lessons-1-15-1");
      if(!r.ok)throw new Error("配音角色目录加载失败，请刷新重试。");
      const other=await r.json();
      if(other.id!==entry.id||!Array.isArray(other.items))throw new Error("课程角色资料不完整，请刷新重试。");
      return other;
    }));
    const number=document.createElement("span");number.textContent=String(lesson.number).padStart(2,"0");
    $("lessonHeading").replaceChildren(number,document.createTextNode(" "+lesson.title));
    document.title="第"+lesson.number+"课 · "+lesson.title+" · 教材跟读";
    save("lastLesson",String(lesson.number));$("lessonSelect").disabled=false;
    state.navMode=read("navMode:"+lesson.id,lesson.number===1?read("navMode"):"unit")==="recordings"?"recordings":"unit";
    const preferred=hash||read("lastItem:"+lesson.id,lesson.number===1?read("lastItem",entry.defaultItem):entry.defaultItem);
    const item=state.lesson.items.find(i=>i.id===preferred)||state.lesson.items[0];
    const speed=read("speed","1");if([...$("speed").options].some(o=>o.value===speed))$("speed").value=speed;
    applyPlaybackSpeed();
    state.loop=read(markedMode?"markedLoop":"loop")==="1";$("loop").setAttribute("aria-pressed",String(state.loop));
    if(markedMode){await loadRecordingIndex();await MarkedPractice.init();await loadVoices();return;}
    const turnParam=new URL(location.href).searchParams.get("turn");
    const requestedTurn=turnParam&&/^\d+$/.test(turnParam)&&hash===item.id?Number(turnParam)-1:undefined;
    await loadRecordingIndex();await selectItem(item.id,requestedTurn);
    if(requestedTurn!==undefined)$("turnList").querySelector(".turn.active")?.scrollIntoView({block:"nearest"});
    await loadVoices();
  } catch(e){$("exerciseTitle").textContent="无法打开课程";notice(e.message);}
}
init();
