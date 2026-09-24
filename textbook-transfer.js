"use strict";
window.TextbookTransfer=(()=>{
  const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  let busy=false;
  window.addEventListener("beforeunload",event=>{if(busy){event.preventDefault();event.returnValue="";}});
  const checkIdle=()=>{if(isRecording())throw new Error("请先结束录音并保存。");if(busy)throw new Error("正在处理，请稍候。");};
  const noteKeys=lesson=>lesson.items.flatMap(i=>["note:"+i.id,"answer:"+i.id,"done:"+i.id]);
  function snapshot(lessons){
    const keys=lessons.flatMap(noteKeys),values={};
    for(const key of keys){const value=read(key);if(value)values[key]=value;}
    const ids=new Set(lessons.map(l=>l.id)),tags=TextbookTags.read();
    return {values,tags:{...tags,sentences:tags.sentences.filter(s=>ids.has(s.lessonId))}};
  }
  function mergeStudy(study,lessons){
    const allowed=new Set(lessons.flatMap(noteKeys));let conflicts=0;
    for(const [key,value] of Object.entries(study?.values||{})){
      if(!allowed.has(key)||typeof value!=="string"||value.length>20000)continue;
      const current=read(key);
      if(!current||current===value){if(!save(key,value))throw new Error("笔记保存失败");continue;}
      if(key.startsWith("done:"))continue;
      const conflictKey="importedVariants:"+key;
      let variants;try{variants=JSON.parse(read(conflictKey,"[]"));}catch{variants=[];}
      if(!variants.some(v=>v.text===value))variants.push({text:value,created:Date.now()});
      if(!save(conflictKey,JSON.stringify(variants)))throw new Error("冲突笔记保存失败");conflicts++;
    }
    const incoming=study?.tags,local=TextbookTags.read(),mapping=new Map();
    if(incoming&&Array.isArray(incoming.tags)&&Array.isArray(incoming.sentences)){
      for(const tag of incoming.tags){
        if(typeof tag.id!=="string"||typeof tag.name!=="string"||!tag.name.trim()||tag.name.length>40)continue;
        const sameName=local.tags.find(t=>t.name===tag.name),sameId=local.tags.find(t=>t.id===tag.id);
        const id=sameName?.id||(!sameId?tag.id:crypto.randomUUID());mapping.set(tag.id,id);
        if(!local.tags.some(t=>t.id===id))local.tags.push({id,name:tag.name});
      }
      for(const sentence of incoming.sentences){
        const lesson=lessons.find(l=>l.id===sentence.lessonId),item=lesson?.items.find(i=>i.id===sentence.exerciseId);
        if(!item||!Number.isInteger(sentence.index)||typeof sentence.text!=="string"||typeof sentence.role!=="string"||!Array.isArray(sentence.tagIds))continue;
        const expected=JSON.stringify([lesson.id,item.id,sentence.index,sentence.role,sentence.text]);if(sentence.key!==expected)continue;
        const tagIds=sentence.tagIds.map(id=>mapping.get(id)).filter(Boolean),old=local.sentences.find(s=>s.key===sentence.key);
        if(old)old.tagIds=[...new Set([...old.tagIds,...tagIds])];
        else if(tagIds.length)local.sentences.push({...sentence,tagIds});
      }
      if(!save("sentenceTags:v1",JSON.stringify(local)))throw new Error("标记保存失败");
      window.dispatchEvent(new Event("textbook-tags-changed"));
    }
    return conflicts;
  }
  async function exportPractice(){
    checkIdle();if(!state.lesson)throw new Error("请先选择一课。");busy=true;try{
      const lessons=window.TextbookOffline?state.lessons:[state.lesson];
      const lessonIds=new Set(lessons.map(l=>l.id));
      const rows=await dbRequest("readonly",s=>s.getAll()),files=new Map(),takes=[];
      for(const take of rows){
        if(!(take.blob instanceof Blob)||!take.sentence||(!window.TextbookOffline&&!lessonIds.has(take.sentence.lessonId)))continue;
        const path="recordings/"+takes.length;files.set(path,take.blob);
        takes.push({id:take.id,exercise:take.exercise,sentence:take.sentence,created:take.created,path});
      }
      notice("正在打包录音和练习记录…");
      const blob=await TextbookPackage.pack(TextbookPackage.RETURN,{takes,study:snapshot(lessons)},files);
      TextbookPackage.download(blob,"教材练习-"+new Date().toISOString().slice(0,10)+".textbook-practice");notice("练习记录包已导出。");
    }finally{busy=false;}
  }
  async function importPractice(file){
    checkIdle();busy=true;try{
      const {payload,files}=await TextbookPackage.unpack(file,TextbookPackage.RETURN,(n,total)=>notice(`正在校验 ${n}/${total}`));
      if(!Array.isArray(payload?.takes)||payload.takes.length>10000)throw new Error("录音清单无效");
      const ids=new Set(),takes=[];
      for(const take of payload.takes){
        if(typeof take.id!=="string"||ids.has(take.id)||typeof take.exercise!=="string"||!Number.isFinite(take.created)||
          !take.sentence||typeof take.sentence.lessonId!=="string"||typeof take.sentence.text!=="string"||
          typeof take.sentence.role!=="string"||!Number.isInteger(take.sentence.index)||!files.get(take.path)?.type.startsWith("audio/"))throw new Error("录音内容无效，未导入。");
        ids.add(take.id);takes.push({...take,blob:files.get(take.path)});
      }
      const db=await state.db;let imported=0,skipped=0;
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("recordings","readwrite"),store=tx.objectStore("recordings");
        for(const take of takes){const r=store.get(take.id);r.onsuccess=()=>{
          const old=r.result;
          const sameSentence=old?.exercise===take.exercise&&old?.sentence?.lessonId===take.sentence.lessonId&&old?.sentence?.index===take.sentence.index&&old?.sentence?.role===take.sentence.role;
          if(!old){store.add(take);imported++;}
          else if(sameSentence&&take.created>old.created){store.put(take);imported++;}
          else skipped++;
        };}
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      const conflicts=mergeStudy(payload.study,state.lessons);
      await loadRecordingIndex();if(state.item)await loadTakes(state.item.id);renderNav();renderTurns();
      if(state.item)$("noteText").value=read("note:"+state.item.id);
      notice(`已导入 ${imported} 条录音，跳过 ${skipped} 条重复录音；${conflicts} 项不同内容保留在“同步时保留的笔记与回答”。`);
    }finally{busy=false;}
  }
  function variantsDialog(){
    const dialog=el("dialog"),title=el("h2","同步时保留的笔记与回答"),close=el("button","关闭");dialog.className="transfer-dialog";close.onclick=()=>dialog.close();dialog.append(title,close);
    let count=0;
    for(const lesson of state.lessons)for(const key of noteKeys(lesson)){
      let variants;try{variants=JSON.parse(read("importedVariants:"+key,"[]"));}catch{continue;}
      for(const value of variants){count++;const item=lesson.items.find(i=>key.endsWith(":"+i.id));dialog.append(el("h3",`第${lesson.number}课 · ${item.title} · ${key.startsWith("note:")?"笔记":"回答"}`),el("p",value.text));}
    }
    if(!count)dialog.append(el("p","没有冲突版本。"));document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
  }
  async function exportCourse(){
    checkIdle();if(!state.lesson)throw new Error("请先选择课程。");
    const lesson=state.lesson,dialog=el("dialog"),title=el("h2",`导出第 ${lesson.number} 课`),list=el("div"),progress=el("p");
    dialog.className="transfer-dialog";progress.setAttribute("role","status");
    const images=el("input");images.type="checkbox";const label=el("label");label.append(images," 包含教材原页");
    const selected=new Set(state.item?[state.item.id]:[]);
    for(const item of lesson.items){
      if(!availableTurns(item).length)continue;
      const input=el("input");input.type="checkbox";input.checked=selected.has(item.id);
      input.onchange=()=>input.checked?selected.add(item.id):selected.delete(item.id);
      const row=el("label");row.append(input,`${item.book} ${item.page}页 · ${item.number} ${item.title}`);list.append(row);
    }
    list.className="export-exercises";
    const start=el("button","检查并导出"),close=el("button","取消");
    close.onclick=()=>dialog.close();dialog.append(title,label,list,start,close,progress);document.body.append(dialog);
    dialog.onclose=()=>{if(!busy)dialog.remove();};dialog.addEventListener("cancel",e=>{if(busy)e.preventDefault();});
    start.onclick=async()=>{
      if(!selected.size){progress.textContent="请选择至少一个练习。";return;}
      busy=true;start.disabled=true;close.disabled=true;list.inert=true;images.disabled=true;
      try{
        const course=structuredClone(lesson);course.items=course.items.filter(i=>selected.has(i.id));
        const jobs=[];for(const item of course.items){
          const source=lesson.items.find(i=>i.id===item.id);item.turns=structuredClone(availableTurns(source));
          // Export the final personal answer without allowing offline re-synthesis.
          if(item.kind==="自由回答")item.kind="个人回答";
          for(const turn of item.turns){turn.offlineSettings={...assignedSettings(turn,source)};jobs.push(turn);}
        }
        const results=new Map();let missing=0;
        for(let i=0;i<jobs.length;i++){
          const turn=jobs[i],key=JSON.stringify([turn.ja,turn.offlineSettings]);
          if(!results.has(key)){
            const result=await api("/api/textbook/tts",{text:turn.ja,...turn.offlineSettings,cache_only:true});
            results.set(key,result);if(!result.available)missing++;
          }
          progress.textContent=`检查已有音频 ${i+1}/${jobs.length}`;
        }
        if(missing&&!confirm(`所选练习缺少 ${missing} 段配音。按当前角色设置在电脑生成后导出？`)){progress.textContent="已取消，没有生成音频。";return;}
        const files=new Map(),audioPaths=new Map(),started=Date.now();
        for(let i=0;i<jobs.length;i++){
          const turn=jobs[i],key=JSON.stringify([turn.ja,turn.offlineSettings]);
          if(!audioPaths.has(key)){
            const ready=results.get(key),result=ready.available?ready:await audioFor(turn,turn.offlineSettings);
            const response=await fetch(result.audio_url);if(!response.ok)throw new Error("无法读取已生成音频");
            const blob=await response.blob(),hash=await ShadowingPackage.sha256Blob(blob),path="audio/"+hash;
            files.set(path,blob.type.startsWith("audio/")?blob:new Blob([blob],{type:"audio/wav"}));audioPaths.set(key,path);
          }
          turn.offlineAudio=audioPaths.get(key);turn.offlineTokens=(await api("/api/kana",{text:turn.ja})).tokens;
          const left=Math.ceil((Date.now()-started)/(i+1)*(jobs.length-i-1)/1000);
          progress.textContent=`准备句子 ${i+1}/${jobs.length} · 预计剩余 ${left} 秒`;
        }
        for(const item of course.items){
          if(images.checked&&item.image){const response=await fetch(item.image);if(!response.ok)throw new Error("原页无法读取");const blob=await response.blob(),path="images/"+await ShadowingPackage.sha256Blob(blob);files.set(path,blob);item.image=path;}
          else item.image="";
          item.related=item.related.filter(id=>selected.has(id));
        }
        TextbookPackage.validateCourse(course,files);
        const blob=await TextbookPackage.pack(TextbookPackage.FORMAT,{course,voices:state.voices},files,(n,total)=>progress.textContent=`校验打包 ${n}/${total}`);
        TextbookPackage.download(blob,`第${lesson.number}课-${lesson.title}.textbook`);progress.textContent="课程包已导出。";
      }catch(e){progress.textContent=e.message;}finally{busy=false;start.disabled=false;close.disabled=false;list.inert=false;images.disabled=false;}
    };
    dialog.showModal();
  }
  document.addEventListener("DOMContentLoaded",()=>{
    const nav=document.querySelector(".app-header nav"),select=el("select"),input=el("input");
    select.setAttribute("aria-label","教材文件操作");select.append(new Option("文件",""));
    if(!window.TextbookOffline)select.append(new Option("导出手机教材包","course"),new Option("导入手机练习记录","import"));
    select.append(new Option(window.TextbookOffline?"导出全部练习到电脑":"导出本课练习记录","export"),new Option("同步时保留的笔记与回答","variants"));
    input.type="file";input.hidden=true;input.onchange=()=>{if(input.files[0])importPractice(input.files[0]).catch(e=>notice(e.message));input.value="";};
    select.onchange=()=>{const action=select.value;select.value="";try{checkIdle();if(action==="course")exportCourse().catch(e=>notice(e.message));if(action==="export")exportPractice().catch(e=>notice(e.message));if(action==="import")input.click();if(action==="variants")variantsDialog();}catch(e){notice(e.message);}};
    nav.append(select,input);
  });
  return {exportCourse,exportPractice,importPractice,mergeStudy,variantsDialog};
})();
