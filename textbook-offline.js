"use strict";
window.TextbookOffline=(()=>{
  let courses,loading;const urls=new Map();
  const all=()=>loading||=(TextbookPackage.request("readonly",s=>s.getAll()).then(rows=>courses=rows));
  function url(path,blob){if(!urls.has(path))urls.set(path,URL.createObjectURL(blob));return urls.get(path);}
  async function fetchCourse(path){
    const rows=await all();
    if(path.startsWith("textbook-lessons.json"))return new Response(JSON.stringify({lessons:rows.sort((a,b)=>a.course.number-b.course.number).map(({course:c})=>({id:c.id,number:c.number,title:c.title,file:c.id,defaultItem:c.items[0].id}))}));
    const row=rows.find(r=>r.id===path.split("?")[0]);if(!row)return new Response("",{status:404});
    const course=structuredClone(row.course);
    for(const item of course.items){
      if(item.image)item.image=url(row.id+item.image,row.files[item.image]);
      item.related=item.related.filter(id=>course.items.some(i=>i.id===id));
    }
    return new Response(JSON.stringify(course));
  }
  async function api(path,payload){
    const rows=await all();
    if(path==="/api/textbook/voices"){
      const voices=[...new Map(rows.flatMap(r=>r.voices).map(v=>[v.style_id,v])).values()];
      return {voices,default_style_id:voices[0]?.style_id};
    }
    if(path==="/api/kana"){
      const turn=rows.flatMap(r=>r.course.items).flatMap(i=>i.turns).find(t=>t.ja===payload.text);
      return {tokens:turn?.offlineTokens||[]};
    }
    throw new Error("此功能需在电脑上使用。");
  }
  async function audioFor(turn){
    const rows=await all(),row=rows.find(r=>r.files[turn.offlineAudio]);
    if(!row)throw new Error("这句未包含已生成的音频，请在电脑导出后更新课程。");
    return {audio_url:url(row.id+turn.offlineAudio,row.files[turn.offlineAudio])};
  }
  document.addEventListener("DOMContentLoaded",()=>{
    document.querySelectorAll('a[href="textbook.html"]').forEach(a=>a.href="mobile-textbook.html");
    document.querySelectorAll('a[href="textbook-marks.html"]').forEach(a=>a.href="mobile-textbook-marks.html");
    for(const id of ["voiceSettings","voiceSummary","freeAnswer"]){const node=document.getElementById(id);if(node)node.hidden=true;}
    document.getElementById("sourceButton")?.addEventListener("click",()=>{if(!state.item?.image){$("sourceDialog").close();notice("此包未包含教材原页。");}});
    if("serviceWorker"in navigator)navigator.serviceWorker.register("mobile-sw.js").catch(()=>{});
  });
  return {fetch:fetchCourse,api,audioFor};
})();
