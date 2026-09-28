"use strict";
window.TextbookTransfer=(()=>{
  const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  let busy=false;
  window.addEventListener("beforeunload",event=>{if(busy){event.preventDefault();event.returnValue="";}});
  const context=()=>typeof state==="object"?state:null;
  const offline=()=>Boolean(window.TextbookOffline)||location.pathname.includes("mobile-textbook");
  const report=text=>{if(typeof notice==="function")notice(text);else{const node=document.getElementById("libraryStatus");if(node)node.textContent=text;}};
  const checkIdle=()=>{if(typeof isRecording==="function"&&isRecording())throw new Error("请先结束录音并保存。");if(busy)throw new Error("正在处理，请稍候。");};
  const noteKeys=lesson=>lesson.items.flatMap(i=>["note:"+i.id,"answer:"+i.id,"done:"+i.id,...i.turns.map((_,n)=>"turnDone:"+i.id+":"+n)]);
  function snapshot(lessons){
    const keys=lessons.flatMap(noteKeys),values={};
    for(const key of keys){const value=read(key);if(value)values[key]=value;}
    const ids=new Set(lessons.map(l=>l.id)),tags=TextbookTags.read();
    return {values,tags:{...tags,sentences:tags.sentences.filter(s=>ids.has(s.lessonId))}};
  }
  async function persistExport(blob,name,progress=()=>{}){
    if(offline()){
      const file=new File([blob],name,{type:blob.type||"application/zip"});
      const share=confirm("文件已准备好。使用系统分享保存到“文件”或发送到电脑？取消则直接下载。");
      if(share&&navigator.canShare?.({files:[file]})){
        try{await navigator.share({files:[file],title:name});return;}catch(error){if(error.name==="AbortError")return;}
      }
      TextbookPackage.download(blob,name);return;
    }
    progress("正在保存到电脑导出目录…");
    const result=await new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest(),started=Date.now();request.open("POST","/api/textbook/exports?name="+encodeURIComponent(name));request.responseType="json";
      request.upload.onprogress=event=>{if(!event.lengthComputable)return;
        const left=event.loaded?Math.ceil((Date.now()-started)/event.loaded*(event.total-event.loaded)/1000):0;
        progress(`保存文件 ${Math.round(event.loaded/event.total*100)}%${left>0?" · 预计剩余 "+left+" 秒":""}`);
      };
      request.onerror=()=>reject(new Error("本地服务连接中断，文件未确认保存；请重新打开 App 后重试。"));
      request.onload=()=>request.status>=200&&request.status<300?resolve(request.response):reject(new Error(request.response?.detail||"导出文件保存失败"));
      request.send(blob);
    });
    progress("已保存："+result.path);return result;
  }
  async function packPractice(scope="all",progress=report,backupRow=null){
    const data=backupRow?null:await TextbookSync.ready(),docs={},files=new Map(),takes=[],archiveTakes=[];
    const source=backupRow?.rows||data.rows,started=Date.now();
    const current=new Map();for(const take of source.filter(t=>t.blob instanceof Blob).sort((a,b)=>a.created-b.created))current.set(TextbookSync.sentenceKey(take),take);
    const ledger=backupRow?{}:data.docs;
    for(const [id,doc] of Object.entries(ledger))if(scope==="all"||!doc.lessonId||doc.lessonId===scope)docs[id]=structuredClone(doc);
    let n=0;const selected=[...current.values()].filter(t=>scope==="all"||TextbookSync.courseId(t)===scope);
    for(const original of selected){
      const take=structuredClone(original),path="recordings/"+takes.length;files.set(path,take.blob);
      let referencePath;
      if(take.analysis){
        let reference=take.referenceBlob;
        if(!reference&&take.analysis.reference?.audio_url){
          const response=await fetch(take.analysis.reference.audio_url);if(response.ok)reference=await response.blob();
        }
        if(reference?.size){
          referencePath="references/"+await ShadowingPackage.sha256Blob(reference);files.set(referencePath,reference);
          take.referenceBlob=reference;
        }else take.analysis={...take.analysis,portableUnavailable:true};
      }
      const value={id:take.id,exercise:take.exercise,sentence:take.sentence||null,created:take.created,
        contentHash:await ShadowingPackage.sha256Blob(take.blob),analysis:TextbookSync.cleanAnalysis(take.analysis),
        referenceHash:take.referenceBlob?await ShadowingPackage.sha256Blob(take.referenceBlob):null};
      const id="take:"+TextbookSync.sentenceKey(take),old=docs[id];
      // The portable reference is metadata, not a new recording. Include it without regenerating speech.
      if(!old||TextbookSync.json(old.value)!==TextbookSync.json(value))docs[id]={kind:"take",key:TextbookSync.sentenceKey(take),lessonId:TextbookSync.courseId(take),
        value,rev:(backupRow?"backup:":"portable:")+await TextbookSync.hash([id,old?.rev,value]),
        ancestors:old?[...old.ancestors,old.rev,...(old.aliases||[])]:[],updated:Date.now()};
      takes.push({...value,path,referencePath});n++;
      const left=Math.ceil((Date.now()-started)/n*(selected.length-n)/1000);
      progress(`准备练习 ${n}/${selected.length}${left>0?" · 预计剩余 "+left+" 秒":""}`);
    }
    if(backupRow){
      // A historical backup is an explicit restore candidate, never an implicit overwrite.
      for(const [key,value] of Object.entries(backupRow.values)){
        const field=key.replace(/^textbook-v1:/,"");if(!/^(note|answer):/.test(field))continue;
        const id="field:"+field;if(!docs[id])docs[id]={kind:"field",key:field,lessonId:"dekiru-2e-intermediate-"+(/^l(\d{2})-/.exec(field.split(":")[1])?.[1]||"01"),value,
          rev:"backup:"+await TextbookSync.hash([id,value]),ancestors:[],updated:backupRow.created};
      }
      const tags=JSON.parse(backupRow.values["textbook-v1:sentenceTags:v1"]||'{"tags":[],"sentences":[]}');
      for(const [kind,entries] of [["tag",tags.tags],["labels",tags.sentences]])for(const value of entries){
        const key=kind==="tag"?value.id:value.key,id=kind+":"+key;
        docs[id]={kind,key,lessonId:kind==="tag"?"":value.lessonId,value,rev:"backup:"+await TextbookSync.hash([id,value]),ancestors:[],updated:backupRow.created};
      }
    }
    for(const original of source.filter(t=>t.blob instanceof Blob&&(scope==="all"||TextbookSync.courseId(t)===scope))){
      if(current.get(TextbookSync.sentenceKey(original))===original)continue;
      const path="history/"+archiveTakes.length;files.set(path,original.blob);
      archiveTakes.push({id:original.id,exercise:original.exercise,sentence:original.sentence||null,created:original.created,
        analysis:TextbookSync.cleanAnalysis(original.analysis),path});
    }
    return TextbookPackage.pack(TextbookPackage.RETURN,{takes,archiveTakes,sync:{version:2,docs},scope,created:Date.now()},files,
      (n,total)=>progress(`校验打包 ${n}/${total}`));
  }
  async function exportPractice(scope=null){
    checkIdle();if(scope===null)return exportDialog();busy=true;
    let ticket;
    try{
      ticket=await window.desktopSession?.begin();
      const blob=await packPractice(scope);
      await persistExport(blob,"教材练习-"+(scope==="all"?"全部":scope.slice(-2))+"-"+Date.now()+".textbook-practice",report);
      report(offline()?"练习包已准备好，请在另一台设备导入。":"练习包已保存，可在“导出文件”中查看和传送。");
    }finally{busy=false;await window.desktopSession?.end(ticket);}
  }
  function closeButton(dialog){const button=el("button");button.type="button";button.className="icon-button sync-close";button.title="关闭";button.setAttribute("aria-label","关闭");
    const icon=el("i");icon.dataset.lucide="x";button.append(icon);button.onclick=()=>{if(dialog.dataset.processing!=="true")dialog.close();};return button;}
  function dialog(title){const node=el("dialog");node.className="transfer-dialog sync-dialog";node.append(el("h2",title),closeButton(node));document.body.append(node);node.onclose=()=>node.remove();window.lucide?.createIcons();return node;}
  async function exportDialog(){
    const node=dialog("导出练习包"),scope=el("select"),start=el("button","导出"),status=el("p");
    scope.setAttribute("aria-label","导出范围");scope.append(new Option("全部课程（含未对应录音）","all"));
    const lessons=context()?.lessons||(await TextbookPackage.request("readonly",s=>s.getAll())).map(r=>r.course);
    for(const lesson of lessons)scope.append(new Option(`第 ${lesson.number} 课 · ${lesson.title}`,lesson.id));
    node.append(scope,start,status);start.onclick=async()=>{
      start.disabled=true;scope.disabled=true;node.dataset.processing="true";
      let ticket;
      try{checkIdle();busy=true;ticket=await window.desktopSession?.begin();const blob=await packPractice(scope.value,text=>status.textContent=text);
        const result=await persistExport(blob,"教材练习-"+(scope.value==="all"?"全部":scope.value.slice(-2))+"-"+Date.now()+".textbook-practice",text=>status.textContent=text);
        status.textContent=result?"已保存："+result.path:"练习包已准备好。";
      }catch(error){status.textContent=error.message;}finally{busy=false;node.dataset.processing="false";start.disabled=false;scope.disabled=false;await window.desktopSession?.end(ticket);}
    };node.addEventListener("cancel",e=>{if(busy)e.preventDefault();});node.showModal();
  }
  function describe(doc){
    if(!doc?.value)return "已删除";
    if(doc.kind==="take")return doc.value.sentence?.text||"未对应录音";
    if(doc.kind==="field")return doc.value;
    if(doc.kind==="tag")return doc.value.name;
    return (doc.value.text||"")+" · "+doc.value.tagIds.length+" 个标记";
  }
  async function confirmPlan(plan,title="导入练习包"){
    return new Promise(resolve=>{
      const node=dialog(title),changed=plan.actions.filter(a=>a.status==="incoming"),conflicts=plan.actions.filter(a=>a.status==="conflict");
      const counts=kind=>plan.actions.filter(a=>a.incoming.kind===kind&&a.incoming.value).length;
      node.append(el("p",`录音 ${counts("take")} · 笔记/回答 ${counts("field")} · 标签 ${counts("tag")} · 标记句子 ${counts("labels")}`),
        el("p",`更新 ${changed.length} 项 · 删除 ${changed.filter(a=>a.incoming.value===null).length} 项 · 冲突 ${conflicts.length} 项 · 其余保持不变`));
      const recordings=plan.actions.filter(a=>a.incoming.kind==="take"&&a.incoming.value).map(a=>a.incoming.value);
      node.append(el("p",`已存分析 ${recordings.filter(t=>t.analysis).length} 份 · 未对应录音 ${recordings.filter(t=>!t.sentence).length} 条 · 历史录音 ${plan.archive.length} 条`));
      const list=el("details"),summary=el("summary","查看更新与删除清单");list.append(summary);
      for(const action of changed)list.append(el("p",`${action.incoming.value===null?"删除":"更新"} · ${action.incoming.lessonId.slice(-2)||"通用"} · ${describe(action.incoming.value===null?action.local:action.incoming).slice(0,120)}`));node.append(list);
      const choices={},start=el("button","确认导入");start.id="confirmPracticeImport";
      for(const action of conflicts){
        const section=el("section"),heading=el("h3",`${action.incoming.lessonId?"第 "+Number(action.incoming.lessonId.slice(-2))+" 课":"通用"} · ${action.incoming.kind==="take"?"录音":action.incoming.kind==="field"?action.incoming.key:"标签"}`);
        const select=el("select");select.setAttribute("aria-label","冲突处理方式");select.append(new Option("请选择保留方式",""),new Option("保留本机","local"),new Option("使用包内版本","incoming"));
        select.onchange=()=>{choices[action.id]=select.value;start.disabled=conflicts.some(a=>!choices[a.id]);};
        section.append(heading,el("p","本机："+describe(action.local)),el("p","包内："+describe(action.incoming)),select);
        if(action.incoming.kind==="take")for(const [label,take] of [["本机录音",plan.local.rows.find(t=>TextbookSync.sentenceKey(t)===action.incoming.key)],["包内录音",plan.byKey.get(action.incoming.key)]]){
          if(!take?.blob)continue;const audio=el("audio");audio.controls=true;const url=URL.createObjectURL(take.blob);audio.src=url;
          node.addEventListener("close",()=>URL.revokeObjectURL(url));section.append(el("small",label),audio);
        }
        node.append(section);
      }
      start.disabled=conflicts.length>0;start.onclick=()=>{node.returnValue="import";node.close();resolve(choices);};
      node.append(start);node.addEventListener("close",()=>{if(node.returnValue!=="import")resolve(null);});node.showModal();
    });
  }
  async function importPayload(payload,files,title){
    const plan=await TextbookSync.prepare(payload,files),choices=await confirmPlan(plan,title);if(!choices)return null;
    const result=await TextbookSync.apply(plan,choices);
    if(context()?.lesson){
      await loadRecordingIndex();if(state.item)await loadTakes(state.item.id);renderNav();renderTurns();
      if(state.item)$("noteText").value=read("note:"+state.item.id);
    }
    report(`同步完成：更新 ${result.updated} 项，删除 ${result.deleted} 项，保持 ${result.skipped} 项。替换前的数据已保留在本机备份。`);return result;
  }
  async function importPractice(file){
    checkIdle();busy=true;
    let ticket;
    try{
      ticket=await window.desktopSession?.begin();
      const {payload,files}=await TextbookPackage.unpack(file,TextbookPackage.RETURN,(n,total)=>report(`正在校验 ${n}/${total}`));
      const ids=[...new Set([...Object.values(payload.sync?.docs||{}).map(d=>d.lessonId),...(payload.takes||[]).map(TextbookSync.courseId),
        ...(payload.study?.tags?.sentences||[]).map(s=>s.lessonId)].filter(Boolean))].sort();
      const scope=await new Promise(resolve=>{
        const node=dialog("选择导入范围"),select=el("select"),next=el("button","查看导入预览");select.setAttribute("aria-label","导入范围");
        select.append(new Option("包内全部课程","all"));for(const id of ids){const lesson=context()?.lessons.find(l=>l.id===id);select.append(new Option(`第 ${Number(id.slice(-2))} 课${lesson?" · "+lesson.title:""}`,id));}
        next.onclick=()=>{node.returnValue="next";node.close();resolve(select.value);};node.addEventListener("close",()=>{if(node.returnValue!=="next")resolve(null);});node.append(select,next);node.showModal();
      });
      if(!scope)return null;
      if(scope!=="all"){
        payload.takes=payload.takes.filter(t=>TextbookSync.courseId(t)===scope);
        if(payload.archiveTakes)payload.archiveTakes=payload.archiveTakes.filter(t=>TextbookSync.courseId(t)===scope);
        if(payload.sync)payload.sync.docs=Object.fromEntries(Object.entries(payload.sync.docs).filter(([,doc])=>!doc.lessonId||doc.lessonId===scope));
        if(payload.study){
          payload.study.values=Object.fromEntries(Object.entries(payload.study.values||{}).filter(([key])=>scope.endsWith(/^l(\d{2})-/.exec(key.split(":")[1])?.[1]||"01")));
          if(payload.study.tags)payload.study.tags.sentences=payload.study.tags.sentences.filter(s=>s.lessonId===scope);
        }
      }
      return await importPayload(payload,files);
    }
    finally{busy=false;await window.desktopSession?.end(ticket);}
  }
  function chooseImport(){checkIdle();const input=el("input");input.type="file";input.accept=".textbook-practice";
    input.onchange=()=>{if(input.files[0])importPractice(input.files[0]).catch(error=>report(error.message));};input.click();}
  async function backupsDialog(){
    checkIdle();const node=dialog("本机数据备份"),rows=await TextbookSync.all("syncBackups");
    for(const row of rows.sort((a,b)=>b.created-a.created)){
      const section=el("section"),exportButton=el("button","导出备份"),remove=el("button","删除此备份");
      section.append(el("h3",new Date(row.created).toLocaleString("zh-CN")),el("p",row.reason+" · "+row.rows.length+" 条录音"),exportButton,remove);
      exportButton.onclick=async()=>{exportButton.disabled=true;try{const blob=await packPractice("all",report,row);await persistExport(blob,"教材备份-"+row.created+".textbook-practice",report);}catch(e){report(e.message);}finally{exportButton.disabled=false;}};
      remove.onclick=async()=>{if(!confirm("仅删除此历史备份？当前录音、笔记和标签不受影响。"))return;const db=await TextbookSync.db();
        await new Promise((resolve,reject)=>{const tx=db.transaction("syncBackups","readwrite");tx.objectStore("syncBackups").delete(row.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});section.remove();};
      node.append(section);
    }
    if(!rows.length)node.append(el("p","暂无备份。"));node.showModal();
  }
  async function exportsDialog(){
    checkIdle();const node=dialog("电脑导出文件"),status=el("p"),open=el("button","打开导出目录");node.append(open,status);node.showModal();
    const response=await fetch("/api/textbook/exports"),data=await response.json();if(!response.ok)throw new Error(data.detail||"无法读取导出目录");
    status.textContent=data.directory;open.onclick=async()=>{try{const response=await fetch("/api/textbook/exports/open",{method:"POST"});if(!response.ok)throw new Error((await response.json()).detail||"无法打开目录");}catch(e){status.textContent=e.message;}};
    for(const row of data.files){const section=el("section"),link=el("a",row.name),remove=el("button","删除文件");link.href="/api/textbook/exports/"+encodeURIComponent(row.name);link.download=row.name;
      section.append(link,el("small",` ${(row.size/1024**2).toFixed(1)} MB · ${new Date(row.modified*1000).toLocaleString("zh-CN")}`),remove);
      remove.onclick=async()=>{if(!confirm("仅删除这个导出文件？浏览器中的课程和练习记录不受影响。"))return;const result=await fetch(link.href,{method:"DELETE"});if(result.ok)section.remove();else status.textContent="删除失败";};node.append(section);
    }
    if(!data.files.length)node.append(el("p","暂无导出文件。"));
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
    const lesson=state.lesson,dialog=el("dialog"),title=el("h2",`导出第 ${lesson.number} 课 · ${lesson.title}`),progress=el("p");
    dialog.className="transfer-dialog";progress.setAttribute("role","status");
    const images=el("input");images.type="checkbox";const label=el("label");label.append(images," 包含教材原页");
    const summary=el("p",`整课 · ${lesson.items.length} 个练习 · ${lesson.items.reduce((n,item)=>n+availableTurns(item).length,0)} 句`);
    const start=el("button","检查并导出"),close=el("button","取消");
    close.onclick=()=>dialog.close();dialog.append(title,summary,label,start,close,progress);document.body.append(dialog);
    dialog.onclose=()=>{if(!busy)dialog.remove();};dialog.addEventListener("cancel",e=>{if(busy)e.preventDefault();});
    start.onclick=async()=>{
      busy=true;start.disabled=true;close.disabled=true;images.disabled=true;
      let ticket;
      try{
        ticket=await window.desktopSession?.begin();
        const course=structuredClone(lesson);
        const jobs=[];for(const item of course.items){
          const source=lesson.items.find(i=>i.id===item.id);item.turns=structuredClone(availableTurns(source));
          // Export the final personal answer without allowing offline re-synthesis.
          if(item.kind==="自由回答"&&item.turns.length)item.kind="个人回答";
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
        if(missing&&!confirm(`第 ${lesson.number} 课缺少 ${missing} 段配音。按当前角色设置在电脑生成后导出整课？`)){progress.textContent="已取消，没有生成音频。";return;}
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
        }
        TextbookPackage.validateCourse(course,files);
        const ledger=await TextbookSync.ready();
        const docs=Object.fromEntries(Object.entries(ledger.docs).filter(([,doc])=>doc.kind==="tag"||doc.kind==="labels"&&doc.lessonId===lesson.id));
        const blob=await TextbookPackage.pack(TextbookPackage.FORMAT,{course,voices:state.voices,tags:snapshot([lesson]).tags,sync:{version:2,docs}},files,(n,total)=>progress.textContent=`校验打包 ${n}/${total}`);
        const result=await persistExport(blob,`第${lesson.number}课-${lesson.title}-${Date.now()}.textbook`,text=>progress.textContent=text);
        progress.textContent=result?"已保存："+result.path:"课程包已准备好。";
      }catch(e){progress.textContent=e.message;}finally{busy=false;start.disabled=false;close.disabled=false;images.disabled=false;await window.desktopSession?.end(ticket);}
    };
    dialog.showModal();
  }
  document.addEventListener("DOMContentLoaded",()=>{
    const nav=document.querySelector(".app-header nav"),select=el("select"),input=el("input");
    select.setAttribute("aria-label","教材文件操作");select.append(new Option("文件",""));
    if(!offline())select.append(new Option("导出手机教材包","course"),new Option("导出文件","files"));
    select.append(new Option("导出练习包（课程/全部）","export"),new Option("导入练习包","import"),new Option("本机数据备份","backups"),new Option("以前保留的笔记与回答","variants"));
    input.type="file";input.hidden=true;input.accept=".textbook-practice";input.onchange=()=>{if(input.files[0])importPractice(input.files[0]).catch(e=>report(e.message));input.value="";};
    select.onchange=()=>{const action=select.value;select.value="";try{checkIdle();const handlers={course:exportCourse,export:exportPractice,files:exportsDialog,backups:backupsDialog,variants:variantsDialog};
      if(action==="import")input.click();else Promise.resolve(handlers[action]?.()).catch(e=>report(e.message));}catch(e){report(e.message);}};
    if(nav&&!document.body.classList.contains("textbook-library"))nav.append(select,input);
    TextbookSync.ready().catch(e=>report("数据备份未完成："+e.message));
  });
  return {exportCourse,exportPractice,importPractice,importPayload,chooseImport,packPractice,confirmPlan,exportsDialog,backupsDialog,variantsDialog};
})();
