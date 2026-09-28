"use strict";
window.TextbookSync=(()=>{
  const PREFIX="textbook-v1:",VERSION=2,DB="textbook-shadowing";
  let opening;
  const clone=value=>structuredClone(value);
  function stable(value){
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
    return value;
  }
  const json=value=>JSON.stringify(stable(value));
  const hash=value=>ShadowingPackage.sha256Blob(new Blob([json(value)]));
  function db(){return opening||=new Promise((resolve,reject)=>{
    let expired=false;
    const fail=error=>{expired=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new Error("本机存储没有响应，请关闭其他教材页面后重试，不要清除网站数据。")),15000);
    const r=indexedDB.open(DB,VERSION);
    r.onupgradeneeded=()=>{
      const database=r.result;
      if(!database.objectStoreNames.contains("recordings")){
        const store=database.createObjectStore("recordings",{keyPath:"id"});store.createIndex("exercise","exercise");
      }
      for(const name of ["syncState","syncBackups"])if(!database.objectStoreNames.contains(name))database.createObjectStore(name,{keyPath:"id"});
    };
    r.onblocked=()=>fail(new Error("请关闭其他教材页面后重试，原数据未改动。"));
    r.onerror=()=>fail(r.error);
    r.onsuccess=()=>{clearTimeout(timer);if(expired){r.result.close();return;}r.result.onversionchange=()=>{r.result.close();opening=null;};resolve(r.result);};
  }).catch(error=>{opening=null;throw error;});}
  async function transact(names,mode,action){
    const database=await db();return new Promise((resolve,reject)=>{
      const tx=database.transaction(names,mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("存储已中止"));
      try{action(tx,value=>{result=value;});}catch(error){tx.abort();reject(error);}
    });
  }
  const get=(store,key)=>transact([store],"readonly",(tx,out)=>{const r=tx.objectStore(store).get(key);r.onsuccess=()=>out(r.result);});
  const all=store=>transact([store],"readonly",(tx,out)=>{const r=tx.objectStore(store).getAll();r.onsuccess=()=>out(r.result);});
  const lock=action=>navigator.locks?navigator.locks.request("textbook-practice-sync",action):action();
  function localSnapshot(){
    const values={};for(let n=0;n<localStorage.length;n++){const key=localStorage.key(n);if(key?.startsWith(PREFIX))values[key]=localStorage.getItem(key);}
    return values;
  }
  function writeLocal(values){
    for(const [key,value] of Object.entries(values)){
      if(!key.startsWith(PREFIX))throw new Error("设置路径无效");
      if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);
    }
    window.dispatchEvent(new Event("textbook-tags-changed"));
  }
  async function recover(){
    const pending=await get("syncState","pending");if(!pending)return;
    writeLocal(pending.values);
    await transact(["syncState"],"readwrite",tx=>tx.objectStore("syncState").delete("pending"));
  }
  async function backup(reason,onlyRows=null){
    await recover();const rows=onlyRows||await all("recordings"),values=localSnapshot(),ledger=await get("syncState","ledger");
    const row={id:Date.now()+"-"+crypto.randomUUID(),created:Date.now(),reason,rows,values,ledger};
    await transact(["syncBackups"],"readwrite",tx=>tx.objectStore("syncBackups").put(row));return row;
  }
  async function ensure(){
    await recover();if(!await get("syncState","initialized")){
      await backup("首次启用双向同步：原始数据");
      await transact(["syncState"],"readwrite",tx=>tx.objectStore("syncState").put({id:"initialized",created:Date.now()}));
    }
  }
  function lessonForExercise(id){return /^l(\d{2})-/.test(id)?"dekiru-2e-intermediate-"+id.slice(1,3):"dekiru-2e-intermediate-01";}
  function sentenceKey(take){
    const s=take.sentence;
    return s?JSON.stringify([s.lessonId,take.exercise||s.exerciseId,s.index,s.role,s.text]):"unmatched:"+take.id;
  }
  function courseId(take){return take.sentence?.lessonId||lessonForExercise(take.exercise||"");}
  function cleanAnalysis(analysis){
    if(!analysis)return null;
    const value=clone(analysis);
    if(value.reference)delete value.reference.audio_url;
    if(value.result)for(const key of Object.keys(value.result))if(key.endsWith("_url"))delete value.result[key];
    return value;
  }
  async function takeValue(take){
    return {id:take.id,exercise:take.exercise,sentence:take.sentence||null,created:take.created,
      contentHash:await ShadowingPackage.sha256Blob(take.blob),analysis:cleanAnalysis(take.analysis),
      referenceHash:take.referenceBlob?await ShadowingPackage.sha256Blob(take.referenceBlob):null};
  }
  async function capture(){
    await ensure();const stored=await get("syncState","ledger"),docs=stored?.docs||{},observed={};
    const put=(kind,key,lessonId,value)=>observed[kind+":"+key]={kind,key,lessonId,value};
    for(const [key,value] of Object.entries(localSnapshot())){
      const name=key.slice(PREFIX.length);
      if(/^(note|answer|importedVariants:(?:note|answer)):/.test(name)){
        const exercise=name.slice(name.indexOf(":")+1).replace(/^(note|answer):/,"");
        put("field",name,lessonForExercise(exercise),value||null);
      }
    }
    let tags;try{tags=JSON.parse(localStorage.getItem(PREFIX+"sentenceTags:v1")||'{"tags":[],"sentences":[]}');}catch{throw new Error("标记无法读取，未开始同步。");}
    for(const tag of tags.tags)put("tag",tag.id,"",tag);
    for(const sentence of tags.sentences)put("labels",sentence.key,sentence.lessonId,sentence);
    const rows=await all("recordings"),bySentence=new Map();
    for(const row of rows.filter(r=>r.blob instanceof Blob).sort((a,b)=>a.created-b.created))bySentence.set(sentenceKey(row),row);
    for(const [key,take] of bySentence)put("take",key,courseId(take),await takeValue(take));
    for(const [id,old] of Object.entries(docs))if(!observed[id])observed[id]={kind:old.kind,key:old.key,lessonId:old.lessonId,value:null};
    for(const [id,value] of Object.entries(observed)){
      const old=docs[id];if(old&&json(old.value)===json(value.value))continue;
      const rev=old?crypto.randomUUID():"base:"+await hash([id,value.value]);
      docs[id]={...value,rev,ancestors:old?[...new Set([...old.ancestors,old.rev,...(old.aliases||[])])]:[],updated:Date.now()};
    }
    await transact(["syncState"],"readwrite",tx=>tx.objectStore("syncState").put({id:"ledger",docs}));
    return {docs,rows,values:localSnapshot()};
  }
  function relation(local,incoming){
    if(!local)return "incoming";
    if(local.rev===incoming.rev||json(local.value)===json(incoming.value))return "same";
    if([incoming.rev,...(incoming.aliases||[])].some(r=>local.ancestors.includes(r)))return "local";
    if([local.rev,...(local.aliases||[])].some(r=>incoming.ancestors.includes(r)))return "incoming";
    // A legacy package has no deletion history; it cannot revive an explicitly deleted item.
    if(incoming.legacy&&local.value===null)return "local";
    return "conflict";
  }
  function validateDoc(doc){
    if(!doc||!["take","field","tag","labels"].includes(doc.kind)||typeof doc.key!=="string"||doc.key.length>12000||
      typeof doc.lessonId!=="string"||!/^$|^dekiru-2e-intermediate-\d{2}$/.test(doc.lessonId)||
      typeof doc.rev!=="string"||!Array.isArray(doc.ancestors)||doc.ancestors.length>20000||!doc.ancestors.every(x=>typeof x==="string")||
      doc.aliases&&(!Array.isArray(doc.aliases)||doc.aliases.length>20000||!doc.aliases.every(x=>typeof x==="string")))throw new Error("同步记录格式无效");
    const value=doc.value;if(value===null)return;
    if(doc.kind==="field"&&(!/^(note|answer|importedVariants:(?:note|answer)):/.test(doc.key)||typeof value!=="string"||value.length>100000))throw new Error("笔记或回答无效");
    if(doc.kind==="tag"&&(value.id!==doc.key||typeof value.name!=="string"||!value.name.trim()||value.name.length>40))throw new Error("标记名称无效");
    if(doc.kind==="labels"&&(!Array.isArray(value.tagIds)||!value.tagIds.every(id=>typeof id==="string")||value.key!==doc.key||value.lessonId!==doc.lessonId||
      value.key!==JSON.stringify([value.lessonId,value.exerciseId,value.index,value.role,value.text])))throw new Error("句子标记无效");
    if(doc.kind==="take"&&(typeof value.id!=="string"||typeof value.exercise!=="string"||!Number.isFinite(value.created)||
      !/^[a-f0-9]{64}$/.test(value.contentHash)||sentenceKey(value)!==doc.key||courseId(value)!==doc.lessonId||
      value.sentence&&(!Number.isInteger(value.sentence.index)||value.sentence.index<0||typeof value.sentence.text!=="string"||typeof value.sentence.role!=="string")))throw new Error("录音清单无效");
  }
  async function legacyDocs(payload,takes){
    const docs={};const add=async(kind,key,lessonId,value)=>{
      const id=kind+":"+key;docs[id]={kind,key,lessonId,value,rev:"legacy:"+await hash([id,value]),ancestors:[],legacy:true,updated:0};
    };
    for(const take of takes)await add("take",sentenceKey(take),courseId(take),await takeValue(take));
    for(const [key,value] of Object.entries(payload.study?.values||{}))if(/^(note|answer):/.test(key))await add("field",key,lessonForExercise(key.split(":").slice(1).join(":")),value);
    for(const tag of payload.study?.tags?.tags||[])await add("tag",tag.id,"",tag);
    for(const sentence of payload.study?.tags?.sentences||[])await add("labels",sentence.key,sentence.lessonId,sentence);
    return docs;
  }
  async function prepare(payload,files){
    const takes=[],archive=[];
    if(!Array.isArray(payload.takes)||payload.takes.length>10000)throw new Error("录音清单无效");
    if(payload.archiveTakes&&!Array.isArray(payload.archiveTakes))throw new Error("历史录音清单无效");
    if((payload.archiveTakes?.length||0)+payload.takes.length>10000)throw new Error("录音数量超过上限");
    const seen=new Set();
    for(const entry of [...payload.takes,...(payload.archiveTakes||[])]){
      const blob=files.get(entry.path);if(!blob?.type.startsWith("audio/")||!blob.size)throw new Error("录音文件缺失");
      if(typeof entry.id!=="string"||typeof entry.exercise!=="string"||!Number.isFinite(entry.created)||seen.has(entry.id))throw new Error("录音身份无效或重复");seen.add(entry.id);
      const referenceBlob=entry.referencePath?files.get(entry.referencePath):undefined;
      if(entry.referencePath&&!referenceBlob?.type.startsWith("audio/"))throw new Error("分析标准音频无效");
      const take={...entry,analysis:cleanAnalysis(entry.analysis),blob,referenceBlob};
      (payload.takes.includes(entry)?takes:archive).push(take);
    }
    takes.sort((a,b)=>a.created-b.created);
    if(payload.sync&&payload.sync.version!==2)throw new Error("同步版本不支持，请先更新程序");
    const incoming=payload.sync?.version===2?payload.sync.docs:await legacyDocs(payload,takes);
    if(!incoming||Object.keys(incoming).length>40000)throw new Error("同步清单过大或缺失");
    const local=await capture(),byKey=new Map(takes.map(t=>[sentenceKey(t),t])),actions=[];
    if(payload.sync&&(byKey.size!==takes.length||takes.some(t=>!incoming["take:"+sentenceKey(t)]?.value)))throw new Error("录音未登记或同一句重复登记");
    for(const [id,doc] of Object.entries(incoming)){
      validateDoc(doc);if(id!==doc.kind+":"+doc.key)throw new Error("同步编号不符");
      if(doc.kind==="take"&&doc.value){
        const take=byKey.get(doc.key);
        if(!take||json(await takeValue(take))!==json(doc.value))throw new Error("录音或分析与清单不符");
      }
      actions.push({id,local:local.docs[id],incoming:doc,status:relation(local.docs[id],doc)});
    }
    return {actions,byKey,local,payload,archive:payload.sync?archive:takes,archiveId:"import-"+await hash(payload)};
  }
  async function apply(plan,choices={}){
    return lock(async()=>{
      const fresh=await capture();
      if(json(fresh.docs)!==json(plan.local.docs))throw new Error("预览期间练习数据发生变化，请重新导入。原数据未覆盖。");
      const chosen=plan.actions.filter(a=>a.status==="incoming"||a.status==="conflict"&&choices[a.id]==="incoming");
      if(plan.actions.some(a=>a.status==="conflict"&&!choices[a.id]))throw new Error("请先选择所有冲突的保留方式");
      if(plan.archive.length&&!await get("syncBackups",plan.archiveId))await transact(["syncBackups"],"readwrite",tx=>tx.objectStore("syncBackups").put({
        id:plan.archiveId,created:Date.now(),reason:"导入包中的历史录音（不增加当前句录音数量）",rows:plan.archive,
        values:localSnapshot(),ledger:null}));
      const docs=clone(fresh.docs),rows=new Map(fresh.rows.map(r=>[r.id,r]));
      for(const action of plan.actions){
        const selected=chosen.includes(action)?action.incoming:action.local;
        if(!selected)continue;
        const ancestors=[...new Set([...(action.local?.ancestors||[]),...(action.incoming.ancestors||[]),
          ...(action.local?.aliases||[]),...(action.incoming.aliases||[]),action.incoming.rev,...(action.local?[action.local.rev]:[])])];
        docs[action.id]=action.status==="conflict"?{...selected,ancestors,rev:crypto.randomUUID(),updated:Date.now()}:
          action.status==="same"?{...selected,ancestors:ancestors.filter(r=>r!==selected.rev),
            aliases:[...new Set([selected.rev,action.incoming.rev,...(selected.aliases||[])])]}:selected;
      }
      if(!chosen.length){
        await transact(["syncState"],"readwrite",tx=>tx.objectStore("syncState").put({id:"ledger",docs}));
        return {updated:0,skipped:plan.actions.length,deleted:0};
      }
      await backup("导入练习包之前");
      for(const action of chosen.filter(a=>a.incoming.kind==="take")){
        for(const [id,take] of rows)if(sentenceKey(take)===action.incoming.key)rows.delete(id);
        if(action.incoming.value){
          const take=clone(plan.byKey.get(action.incoming.key));delete take.path;delete take.referencePath;
          // UUID collisions must not replace a different sentence.
          if(rows.has(take.id))take.id=crypto.randomUUID();
          rows.set(take.id,take);docs[action.id].value.id=take.id;
        }
      }
      const values={},tags={version:1,tags:[],sentences:[]};
      for(const doc of Object.values(docs)){
        if(doc.kind==="field")values[PREFIX+doc.key]=doc.value;
        if(doc.kind==="tag"&&doc.value)tags.tags.push(doc.value);
      }
      const tagIds=new Set(tags.tags.map(t=>t.id));
      for(const doc of Object.values(docs))if(doc.kind==="labels"&&doc.value){
        const sentence={...doc.value,tagIds:doc.value.tagIds.filter(id=>tagIds.has(id))};
        if(sentence.tagIds.length)tags.sentences.push(sentence);
      }
      values[PREFIX+"sentenceTags:v1"]=JSON.stringify(tags);
      // Commit audio and a replayable localStorage journal together; interrupted imports resume on the next open.
      await transact(["recordings","syncState"],"readwrite",tx=>{
        const store=tx.objectStore("recordings"),previous=new Map(fresh.rows.map(row=>[row.id,row]));
        for(const row of fresh.rows)if(!rows.has(row.id))store.delete(row.id);
        for(const row of rows.values())if(previous.get(row.id)!==row)store.put(row);
        tx.objectStore("syncState").put({id:"ledger",docs});tx.objectStore("syncState").put({id:"pending",values});
      });
      await recover();return {updated:chosen.length,skipped:plan.actions.length-chosen.length,deleted:chosen.filter(a=>a.incoming.value===null).length};
    });
  }
  async function replaceRecording(take,matches){
    return lock(async()=>{
      await capture();
      if(matches.length)await backup("重新录制前保留旧录音",matches);
      if(matches.length){take.id=matches[0].id;take.exercise=matches[0].exercise;}
      await transact(["recordings"],"readwrite",tx=>{
        const store=tx.objectStore("recordings");for(const old of matches)store.delete(old.id);store.put(take);
      });
      await capture();return take;
    });
  }
  async function deleteRecording(id,guard=()=>{}){return lock(async()=>{
    await capture();const old=await get("recordings",id);if(!old)return;guard(old);
    await backup("删除录音前",[old]);await transact(["recordings"],"readwrite",tx=>{
      const store=tx.objectStore("recordings"),r=store.get(id);r.onsuccess=()=>{
        try{if(r.result){guard(r.result);store.delete(id);}}catch{tx.abort();}
      };
    });await capture();
  });}
  async function ready(){return lock(capture);}
  return {db,all,backup,ready,capture,prepare,apply,replaceRecording,deleteRecording,sentenceKey,courseId,cleanAnalysis,hash,json,lock};
})();
