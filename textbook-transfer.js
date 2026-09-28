"use strict";
window.TextbookTransfer=(()=>{
  const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const actionButton=(icon,label,iconOnly=false)=>{
    const button=el("button"),symbol=el("i");button.type="button";symbol.dataset.lucide=icon;button.append(symbol);
    button.title=label;button.setAttribute("aria-label",label);
    if(iconOnly)button.className="icon-button";else{button.className="transfer-action";button.append(el("span",label));}
    return button;
  };
  const courses=async()=>context()?.lessons||(await TextbookPackage.request("readonly",s=>s.getAll())).map(row=>row.course);
  let busy=false;
  window.addEventListener("beforeunload",event=>{if(busy){event.preventDefault();event.returnValue="";}});
  const context=()=>typeof state==="object"?state:null;
  const offline=()=>Boolean(window.TextbookOffline)||location.pathname.includes("mobile-textbook");
  const report=text=>{if(typeof notice==="function")notice(text);else{const node=document.getElementById("libraryStatus");if(node)node.textContent=text;}};
  const checkIdle=()=>{if(typeof isRecording==="function"&&isRecording())throw new Error("请先结束录音并保存。");if(context()?.analysisWork?.size)throw new Error("请等本句分析保存完成后再同步。");if(busy)throw new Error("正在处理，请稍候。");};
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
      if(!navigator.canShare?.({files:[file]})){TextbookPackage.download(blob,name);return;}
      // Sharing requires a fresh tap after asynchronous packing, especially in Safari.
      await new Promise(resolve=>{
        const node=dialog("保存练习文件"),share=actionButton("share-2","分享或存到文件"),download=actionButton("download","下载文件"),status=el("p",name);
        share.onclick=async()=>{share.disabled=true;download.disabled=true;try{await navigator.share({files:[file],title:name});node.close();}
          catch(error){status.textContent=error.name==="AbortError"?"未分享，可选择下载。":error.message;}finally{share.disabled=false;download.disabled=false;}};
        download.onclick=()=>{TextbookPackage.download(blob,name);node.close();};node.append(status,share,download);node.addEventListener("close",()=>resolve());node.showModal();
      });return;
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
      report(offline()?"练习记录已导出，可到电脑的“导入与导出 → 我的练习”中导入。":"练习记录已保存，可在“导入与导出 → 文件与历史”中查看。");
    }finally{busy=false;await window.desktopSession?.end(ticket);}
  }
  function closeButton(dialog){const button=el("button");button.type="button";button.className="icon-button sync-close";button.title="关闭";button.setAttribute("aria-label","关闭");
    const icon=el("i");icon.dataset.lucide="x";button.append(icon);button.onclick=()=>{if(dialog.dataset.processing!=="true")dialog.close();};return button;}
  function dialog(title){const node=el("dialog");node.className="transfer-dialog sync-dialog";node.append(el("h2",title),closeButton(node));document.body.append(node);node.onclose=()=>node.remove();
    node.addEventListener("cancel",event=>{if(node.dataset.processing==="true")event.preventDefault();});window.lucide?.createIcons();return node;}
  function exportDialog(){return openHub("practice");}
  async function renderPractice(container,node){
    container.append(el("p","把我的录音、笔记、回答和标记合成一个文件，在电脑与手机之间同步。"));
    const more=el("details"),summary=el("summary","还包含哪些内容？");
    more.append(summary,el("p","已保存的跟读分析、手动音拍、循环区间和历史录音也会保留；不包含教材和标准配音。"));container.append(more);
    const section=el("section"),scope=el("select"),start=actionButton("download","导出练习记录"),status=el("p"),label=el("label","导出范围");
    section.className="transfer-section";section.append(el("h3","导出我的练习"));
    scope.setAttribute("aria-label","导出范围");scope.append(new Option("全部课程（含未对应录音）","all"));
    const lessons=await courses();
    for(const lesson of lessons)scope.append(new Option(`第 ${lesson.number} 课 · ${lesson.title}`,lesson.id));
    label.append(scope);section.append(label,start,status);status.setAttribute("role","status");container.append(section);
    const incoming=el("section"),choose=actionButton("upload","导入练习记录");incoming.className="transfer-section";
    incoming.append(el("h3","导入另一台设备的练习"),el("p","选择导出的练习文件。导入前会显示变更，有冲突时由你选择保留哪一份。"),choose);container.append(incoming);
    choose.onclick=()=>{try{checkIdle();node.close();chooseImport();}catch(error){report(error.message);}};
    start.onclick=async()=>{
      start.disabled=true;scope.disabled=true;node.dataset.processing="true";
      let ticket;
      try{checkIdle();busy=true;ticket=await window.desktopSession?.begin();const blob=await packPractice(scope.value,text=>status.textContent=text);
        const result=await persistExport(blob,"教材练习-"+(scope.value==="all"?"全部":scope.value.slice(-2))+"-"+Date.now()+".textbook-practice",text=>status.textContent=text);
        status.textContent=result?"已保存，可在“文件与历史”中查看。\n"+result.path:"练习记录已导出，可在另一台设备导入。";
      }catch(error){status.textContent=error.message;}finally{busy=false;node.dataset.processing="false";start.disabled=false;scope.disabled=false;await window.desktopSession?.end(ticket);}
    };window.lucide?.createIcons();
  }
  function describe(doc){
    if(!doc?.value)return "已删除";
    if(doc.kind==="take")return doc.value.sentence?.text||"未对应录音";
    if(doc.kind==="field")return doc.value;
    if(doc.kind==="tag")return doc.value.name;
    return (doc.value.text||"")+" · "+doc.value.tagIds.length+" 个标记";
  }
  async function confirmPlan(plan,title="确认导入练习记录"){
    return new Promise(resolve=>{
      const node=dialog(title),changed=plan.actions.filter(a=>a.status==="incoming"),conflicts=plan.actions.filter(a=>a.status==="conflict");
      const counts=kind=>plan.actions.filter(a=>a.incoming.kind===kind&&a.incoming.value).length;
      node.append(el("p",`录音 ${counts("take")} · 笔记与回答 ${counts("field")} · 标签 ${counts("tag")} · 标记句子 ${counts("labels")}`),
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
    if(context()?.lesson){cancelPlayback();stopPreview();clearAudio();$("recordedAudio").pause();if($("analysisDialog").open)closeSentenceAnalysis();livePractice?.close();}
    const result=await TextbookSync.apply(plan,choices);
    if(context()?.lesson){
      for(const lesson of state.lessons)lesson.items.forEach(readPersonal);
      if(state.turn>=itemTurns().length)state.turn=0;
      await loadRecordingIndex();if(state.item)await loadTakes(state.item.id);renderNav();renderTurns();
      if(state.item){$("noteText").value=read("note:"+state.item.id);$("personalText").value=read("answer:"+state.item.id);}
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
        const node=dialog("导入练习记录"),select=el("select"),next=actionButton("arrow-right","查看导入预览");select.setAttribute("aria-label","导入范围");
        select.append(new Option("包内全部课程","all"));for(const id of ids){const lesson=context()?.lessons.find(l=>l.id===id);select.append(new Option(`第 ${Number(id.slice(-2))} 课${lesson?" · "+lesson.title:""}`,id));}
        next.onclick=()=>{node.returnValue="next";node.close();resolve(select.value);};node.addEventListener("close",()=>{if(node.returnValue!=="next")resolve(null);});
        node.append(el("p","选择要同步的课程。下一步先查看变更，不会立即覆盖本机数据。"),select,next);window.lucide?.createIcons();node.showModal();
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
  function backupsDialog(){return openHub("history",true);}
  async function renderBackups(container,node){
    const rows=await TextbookSync.all("syncBackups"),status=el("p");status.setAttribute("role","status");container.append(status);
    for(const row of rows.sort((a,b)=>b.created-a.created)){
      const section=el("section"),exportButton=actionButton("download","导出此备份",true),remove=actionButton("trash-2","删除此备份",true),actions=el("div");
      section.className="transfer-file";actions.className="transfer-row-actions";actions.append(exportButton,remove);
      const info=el("div");info.append(el("h3",new Date(row.created).toLocaleString("zh-CN")),el("p",row.reason.replace("练习包","练习记录")+" · "+row.rows.length+" 条录音"));section.append(info,actions);
      exportButton.onclick=async()=>{
        let ticket;exportButton.disabled=true;
        try{checkIdle();busy=true;node.dataset.processing="true";ticket=await window.desktopSession?.begin();
          const blob=await packPractice("all",text=>status.textContent=text,row);
          const result=await persistExport(blob,"教材备份-"+row.created+".textbook-practice",text=>status.textContent=text);
          status.textContent=result?"备份已导出，可在上方的导出文件中查看。\n"+result.path:"备份已导出，重新导入即可选择恢复。";
        }catch(e){status.textContent=e.message;}finally{busy=false;node.dataset.processing="false";exportButton.disabled=false;await window.desktopSession?.end(ticket);}
      };
      remove.onclick=async()=>{try{checkIdle();if(!confirm("仅删除此历史备份？当前录音、笔记和标签不受影响。"))return;const db=await TextbookSync.db();
        await new Promise((resolve,reject)=>{const tx=db.transaction("syncBackups","readwrite");tx.objectStore("syncBackups").delete(row.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});section.remove();status.textContent="已删除此备份，当前练习不变。";
      }catch(e){status.textContent=e.message;}};
      container.append(section);
    }
    if(!rows.length)container.append(el("p","暂无历史备份。"));window.lucide?.createIcons();
  }
  function exportsDialog(){return openHub("history");}
  async function renderFiles(container){
    const status=el("p"),open=actionButton("folder-open","打开导出文件夹"),refresh=actionButton("refresh-cw","刷新文件列表",true),toolbar=el("div"),list=el("div");
    toolbar.className="transfer-row-actions";toolbar.append(open,refresh);status.className="transfer-path";status.setAttribute("role","status");container.append(toolbar,status,list);
    open.onclick=async()=>{try{checkIdle();const response=await fetch("/api/textbook/exports/open",{method:"POST"});if(!response.ok)throw new Error((await response.json()).detail||"无法打开目录");}catch(e){status.textContent=e.message;}};
    const load=async()=>{
      refresh.disabled=true;
      try{
        const response=await fetch("/api/textbook/exports"),data=await response.json();if(!response.ok)throw new Error(data.detail||"无法读取导出文件夹");
        status.textContent=data.directory;list.replaceChildren();
        for(const row of data.files){
          const section=el("section"),info=el("div"),link=el("a",row.name),remove=actionButton("trash-2","删除导出文件",true);
          const kind=row.name.endsWith(".textbook")?"手机教材":row.name.startsWith("教材备份-")?"历史备份":"练习记录";
          section.className="transfer-file";link.href="/api/textbook/exports/"+encodeURIComponent(row.name);link.download=row.name;link.title="下载 "+row.name;
          info.append(link,el("small",`${kind} · ${(row.size/1024**2).toFixed(1)} MB · ${new Date(row.modified*1000).toLocaleString("zh-CN")}`));section.append(info,remove);
          remove.onclick=async()=>{try{checkIdle();if(!confirm("仅删除这个导出文件？浏览器中的课程和练习记录不受影响。"))return;
            const result=await fetch(link.href,{method:"DELETE"});if(!result.ok)throw new Error("删除失败");await load();
          }catch(e){status.textContent=e.message;}};list.append(section);
        }
        if(!data.files.length)list.append(el("p","还没有导出文件。"));window.lucide?.createIcons();
      }catch(e){status.textContent=e.message;}finally{refresh.disabled=false;}
    };
    refresh.onclick=()=>{try{checkIdle();void load();}catch(e){status.textContent=e.message;}};await load();
  }
  function legacyVariants(){
    const rows=[];
    for(let n=0;n<localStorage.length;n++){
      const name=localStorage.key(n),match=/^textbook-v1:importedVariants:(note|answer):(.+)$/.exec(name);if(!match)continue;
      try{for(const value of JSON.parse(localStorage.getItem(name)||"[]"))if(typeof value.text==="string")rows.push({kind:match[1],itemId:match[2],text:value.text});}catch{}
    }
    return rows;
  }
  function variantsDialog(){return openHub("history",true);}
  async function renderHistory(container,node,expanded=false){
    if(!offline()){
      container.append(el("h3","已导出的文件"));await renderFiles(container);
    }else container.append(el("p","手机导出的文件保存在系统“文件”App中，这里管理本机的历史备份。"));
    const backups=el("details"),backupList=el("div");backups.className="transfer-history";
    backups.append(el("summary","替换前的备份"),el("p","重录、删除和导入前自动保留的数据。导出备份后，可通过“我的练习”重新导入恢复。"),backupList);container.append(backups);
    let loaded=false;backups.addEventListener("toggle",async()=>{if(!backups.open||loaded)return;loaded=true;
      try{await renderBackups(backupList,node);}catch(e){backupList.textContent=e.message;}
    });backups.open=expanded;
    const rows=legacyVariants();
    if(rows.length){
      const details=el("details");details.className="transfer-history";details.append(el("summary",`旧笔记与回答 · ${rows.length} 份`));container.append(details);
      const lessons=await courses();
      for(const row of rows){
        const lesson=lessons.find(l=>l.items.some(i=>i.id===row.itemId)),item=lesson?.items.find(i=>i.id===row.itemId),section=el("section");
        section.append(el("h3",`第 ${lesson?.number||Number(/^l(\d{2})-/.exec(row.itemId)?.[1]||1)} 课 · ${item?.title||"原练习"} · ${row.kind==="note"?"笔记":"回答"}`),el("p",row.text));details.append(section);
      }
    }
  }
  function chooseCourse(node,status){
    checkIdle();const input=el("input");input.type="file";input.accept=".textbook";
    input.onchange=async()=>{
      const file=input.files[0];if(!file)return;let row;
      try{checkIdle();busy=true;node.dataset.processing="true";
        row=await TextbookPackage.importCourse(file,(n,total,phase)=>status.textContent=phase||`正在校验 ${n}/${total}`);
        status.textContent=row?(row.tagWarning||(row.tagsImported?"教材和标记已添加，可以离线练习。":"教材已添加，可以离线练习。")):"已取消，原教材不变。";
        if(row)window.dispatchEvent(new CustomEvent("textbook-course-imported",{detail:row}));
      }catch(e){status.textContent=e.name==="QuotaExceededError"?"手机存储空间不足，原教材未改动。":e.message;}
      finally{busy=false;node.dataset.processing="false";}
      if(row&&context()?.lesson)location.href="mobile-textbook.html?lesson="+row.course.number;
    };input.click();
  }
  async function openHub(selected="practice",expanded=false){
    checkIdle();const node=dialog("导入与导出"),tabs=el("div"),message=el("p");tabs.className="transfer-tabs";tabs.setAttribute("role","tablist");tabs.setAttribute("aria-label","文件内容");message.setAttribute("role","status");
    node.append(tabs,message);let panel;
    const buttons=new Map();
    const activate=async key=>{
      try{checkIdle();}catch(e){message.textContent=e.message;return;}
      message.textContent="";panel?.remove();panel=el("div");panel.id="transferPanel-"+key;panel.className="transfer-content";panel.setAttribute("role","tabpanel");panel.setAttribute("aria-labelledby","transferTab-"+key);node.append(panel);
      for(const [name,button] of buttons){button.setAttribute("aria-selected",String(name===key));button.tabIndex=name===key?0:-1;}
      const content=panel;
      try{
        if(key==="practice")await renderPractice(content,node);
        else if(key==="history")await renderHistory(content,node,expanded);
        else if(offline()){
          content.append(el("p","添加电脑导出的教材，包含课文、注音和标准配音，导入后可离线使用。"));
          const add=actionButton("file-up","添加教材"),status=el("p"),library=el("a","查看我的教材");status.setAttribute("role","status");library.href="mobile-textbook-library.html";library.className="transfer-library";
          add.onclick=()=>{try{chooseCourse(node,status);}catch(e){status.textContent=e.message;}};content.append(add,library,status);
        }else{content.append(el("p","把当前整课的课文、注音和标准配音带到手机。不包含你的录音和笔记。"));await exportCourse(content);}
        window.lucide?.createIcons();
      }catch(e){content.append(el("p",e.message));}
    };
    for(const [key,title] of [["material","教材"],["practice","我的练习"],["history","文件与历史"]]){
      const button=el("button",title);button.type="button";button.setAttribute("role","tab");button.id="transferTab-"+key;button.setAttribute("aria-controls","transferPanel-"+key);button.onclick=()=>activate(key);tabs.append(button);buttons.set(key,button);
      button.onkeydown=event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();
        const keys=[...buttons.keys()],index=keys.indexOf(key),next=event.key==="Home"?keys[0]:event.key==="End"?keys.at(-1):keys[(index+(event.key==="ArrowRight"?1:2))%keys.length];
        if(!busy){buttons.get(next).focus();void activate(next);}
      };
    }
    node.showModal();await activate(selected);return node;
  }
  async function exportCourse(container=null){
    checkIdle();if(!container)return openHub("material");if(!context()?.lesson)throw new Error("请先选择要导出的课程。");
    const lesson=state.lesson,node=container.closest("dialog"),title=el("h3",`第 ${lesson.number} 课 · ${lesson.title}`),progress=el("p");progress.setAttribute("role","status");
    const images=el("input");images.type="checkbox";const label=el("label");label.append(images," 包含教材原页");
    const summary=el("p",`整课 · ${lesson.items.length} 个练习 · ${lesson.items.reduce((n,item)=>n+availableTurns(item).length,0)} 句`);
    const start=actionButton("smartphone","导出本课教材");container.append(title,summary,label,start,progress);
    start.onclick=async()=>{
      busy=true;node.dataset.processing="true";start.disabled=true;images.disabled=true;
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
        progress.textContent=result?"教材已导出，可在“文件与历史”中查看。\n在手机的“导入与导出 → 教材”中添加这个文件。\n"+result.path:"教材已导出。";
      }catch(e){progress.textContent=e.message;}finally{busy=false;node.dataset.processing="false";start.disabled=false;images.disabled=false;await window.desktopSession?.end(ticket);}
    };
  }
  document.addEventListener("DOMContentLoaded",()=>{
    const nav=document.querySelector(".app-header nav");
    if(nav&&!offline()){
      const button=actionButton("arrow-down-up","导入与导出");button.id="textbookTransfer";
      button.onclick=()=>openHub().catch(e=>report(e.message));nav.append(button);window.lucide?.createIcons();
    }
    TextbookSync.ready().catch(e=>report("数据备份未完成："+e.message));
  });
  return {openHub,exportCourse,exportPractice,importPractice,importPayload,chooseImport,packPractice,confirmPlan,exportsDialog,backupsDialog,variantsDialog};
})();
