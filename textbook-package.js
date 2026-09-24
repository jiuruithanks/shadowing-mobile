"use strict";
window.TextbookPackage=(()=>{
  const FORMAT="textbook-offline-course",RETURN="textbook-practice-return",VERSION=1;
  const json=value=>new Blob([JSON.stringify(value)],{type:"application/json"});
  function check(ok,message){if(!ok)throw new Error(message);}
  function optionalStorage(name){
    return new Promise(resolve=>{
      const timer=setTimeout(()=>resolve(null),2000);
      Promise.resolve().then(()=>navigator.storage?.[name]?.()).then(
        value=>{clearTimeout(timer);resolve(value);},
        ()=>{clearTimeout(timer);resolve(null);});
    });
  }
  async function pack(format,payload,files,progress=()=>{}) {
    check(files.size<1000,"文件超过 999 个，请减少所选练习或分课导出。");
    const entries=[],descriptors=[];
    for(const [path,blob] of files){
      check(blob instanceof Blob&&blob.size>0,"文件为空："+path);
      descriptors.push({path,size:blob.size,type:blob.type,sha256:await ShadowingPackage.sha256Blob(blob)});
      entries.push({name:path,data:blob});progress(descriptors.length,files.size);
    }
    entries.push({name:"manifest.json",data:json({format,version:VERSION,payload,files:descriptors})});
    return ShadowingPackage.createStoredZip(entries);
  }
  async function unpack(file,format,progress=()=>{}) {
    check(file.size<2*1024**3,"包超过 2 GB，请分练习导出。");
    const entries=await ShadowingPackage.readEntries(file),manifest=entries.get("manifest.json");
    check(manifest&&manifest.uncompressedSize<16*1024**2,"缺少或无效的包清单");
    const data=JSON.parse(await (await ShadowingPackage.entryBlob(file,manifest)).text());
    check(data.format===format&&data.version===VERSION,"包类型或版本不支持");
    check(Array.isArray(data.files)&&data.files.length<1000,"文件数量无效");
    const files=new Map();
    for(const descriptor of data.files){
      check(typeof descriptor.path==="string"&&!files.has(descriptor.path),"重复的文件路径");
      const entry=entries.get(descriptor.path);
      check(entry&&entry.uncompressedSize===descriptor.size,"文件缺失或大小不符："+descriptor.path);
      const blob=await ShadowingPackage.entryBlob(file,entry,descriptor.type||"application/octet-stream");
      check(await ShadowingPackage.sha256Blob(blob)===descriptor.sha256,"文件校验失败："+descriptor.path);
      // Detach Files-app slices before IndexedDB stores them (notably on iOS).
      files.set(descriptor.path,new Blob([await blob.arrayBuffer()],{type:blob.type}));progress(files.size,data.files.length);
    }
    check(entries.size===files.size+1,"包内存在未登记的文件");
    return {payload:data.payload,files};
  }
  let database;
  function db(){return database||=(new Promise((resolve,reject)=>{
    let expired=false;
    const fail=error=>{expired=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new Error("本机存储未响应，请关闭其他教材页面后重试；不要清除网站数据。")),15000);
    const r=indexedDB.open("textbook-offline-courses",1);
    r.onupgradeneeded=()=>r.result.createObjectStore("courses",{keyPath:"id"});
    r.onblocked=()=>fail(new Error("本机存储被其他页面占用，请关闭其他教材页面后重试。"));
    r.onsuccess=()=>{clearTimeout(timer);if(expired){r.result.close();return;}r.result.onversionchange=()=>{r.result.close();database=null;};resolve(r.result);};
    r.onerror=()=>fail(r.error);
  })).catch(error=>{database=null;throw error;});}
  async function request(mode,action){
    const database=await db();return new Promise((resolve,reject)=>{
      const tx=database.transaction("courses",mode);let value;
      const timer=setTimeout(()=>{try{tx.abort();}catch{}reject(new Error("本机保存超时，请重试。原有课程、录音和笔记未删除。"));},60000);
      tx.oncomplete=()=>{clearTimeout(timer);resolve(value);};
      tx.onerror=()=>{clearTimeout(timer);reject(tx.error);};
      tx.onabort=()=>{clearTimeout(timer);reject(tx.error||new Error("存储已中止"));};
      try{const r=action(tx.objectStore("courses"));r.onsuccess=()=>value=r.result;}
      catch(error){clearTimeout(timer);try{tx.abort();}catch{}reject(error);}
    });
  }
  function validateCourse(course,files){
    check(course&&typeof course.id==="string"&&/^dekiru-2e-intermediate-\d{2}$/.test(course.id),"课程编号无效");
    check(Number.isInteger(course.number)&&course.number>0&&typeof course.title==="string","课程信息无效");
    check(course.id===`dekiru-2e-intermediate-${String(course.number).padStart(2,"0")}`,"课程编号与名称不一致");
    check(Array.isArray(course.units)&&course.units.every(x=>typeof x==="string"),"课程分类无效");
    check(Array.isArray(course.items)&&course.items.length>0&&course.items.length<=2000,"练习列表无效");
    const ids=new Set();
    for(const item of course.items){
      check(typeof item.id==="string"&&!ids.has(item.id)&&Array.isArray(item.turns),"练习编号无效或重复");ids.add(item.id);
      check(typeof item.title==="string"&&course.units.includes(item.unit)&&Array.isArray(item.related),"练习内容无效");
      if(item.image)check(files.has(item.image)&&files.get(item.image).type.startsWith("image/"),"原页图片缺失");
      for(const turn of item.turns){
        check(typeof turn.ja==="string"&&typeof turn.zh==="string"&&typeof turn.role==="string","句子内容无效");
        check(turn.offlineAudio&&files.has(turn.offlineAudio)&&files.get(turn.offlineAudio).type.startsWith("audio/"),"句子音频缺失");
        check(Array.isArray(turn.offlineTokens)&&turn.offlineTokens.every(t=>typeof t.surface==="string"&&typeof t.reading==="string"),"注音缺失");
        // The kana service normalizes compatibility characters before tokenizing.
        check(turn.offlineTokens.map(t=>t.surface).join("").normalize("NFKC").trim()===turn.ja.normalize("NFKC").trim(),"注音与原文不符");
      }
    }
  }
  async function importCourse(file,progress=()=>{}){
    const {payload,files}=await unpack(file,FORMAT,progress);validateCourse(payload?.course,files);
    check(Array.isArray(payload.voices)&&payload.voices.length>0,"缺少音色信息");
    progress(0,1,"检查本机存储");
    const estimate=await optionalStorage("estimate");
    if(estimate?.quota)check(estimate.quota-estimate.usage>file.size*1.15,"本机空间不足，请先删除不需要的课程。");
    progress(0,1,"读取已有课程");
    const existing=await request("readonly",s=>s.get(payload.course.id));
    if(existing&&!confirm("此课已导入。更新同编号练习并保留其他练习、录音和笔记？"))return null;
    const items=new Map((existing?.course.items||[]).map(i=>[i.id,i]));payload.course.items.forEach(i=>items.set(i.id,i));
    const mergedFiles={...existing?.files,...Object.fromEntries(files)};
    const course={...payload.course,items:[...items.values()]};
    const used=new Set(course.items.flatMap(i=>[i.image,...i.turns.map(t=>t.offlineAudio)]).filter(Boolean));
    const kept=Object.fromEntries(Object.entries(mergedFiles).filter(([key])=>used.has(key)));
    const row={id:course.id,course,voices:payload.voices,files:kept,updated:Date.now(),size:Object.values(kept).reduce((n,b)=>n+b.size,0)};
    progress(0,1,"正在保存课程到本机，请保持页面打开");
    await request("readwrite",s=>s.put(row));
    // Persistence is advisory; a pending permission must not block a committed import.
    void optionalStorage("persist");
    progress(1,1,"课程已保存到本机");return row;
  }
  function download(blob,name){
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  return {FORMAT,RETURN,pack,unpack,validateCourse,importCourse,request,download};
})();
