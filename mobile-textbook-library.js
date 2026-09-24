"use strict";
(()=>{
  const $=id=>document.getElementById(id),el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  async function render(){
    const rows=await TextbookPackage.request("readonly",s=>s.getAll());$("courseLibrary").replaceChildren();
    if(!rows.length)$("courseLibrary").append(el("p","暂无课程"));
    for(const row of rows.sort((a,b)=>a.course.number-b.course.number)){
      const section=el("section"),heading=el("h2"),open=el("a",`第 ${row.course.number} 课 · ${row.course.title}`);
      open.href="mobile-textbook.html?lesson="+row.course.number;heading.append(open);
      const meta=el("p",`${row.course.items.length} 个练习 · ${(row.size/1024**2).toFixed(1)} MB`);
      const details=el("details"),summary=el("summary","更多"),remove=el("button","删除课程包");
      remove.className="text-button";remove.onclick=async()=>{
        if(!confirm("删除此课程的离线教材和配音？录音、笔记及标记仍保留。请先导出需要备份的练习记录。"))return;
        try{await TextbookPackage.request("readwrite",s=>s.delete(row.id));await render();}catch(e){$("libraryStatus").textContent=e.message;}
      };
      details.append(summary,remove);section.append(heading,meta,details);$("courseLibrary").append(section);
    }
    window.lucide?.createIcons();
  }
  $("importCourse").onclick=()=>$("courseFile").click();
  $("courseFile").onchange=async()=>{
    const file=$("courseFile").files[0];if(!file)return;$("importCourse").disabled=true;
    try{
      const row=await TextbookPackage.importCourse(file,(n,total)=>$("libraryStatus").textContent=`正在校验 ${n}/${total}`);
      $("libraryStatus").textContent=row?"课程已保存到本机。":"未更新课程。";await render();
    }catch(e){$("libraryStatus").textContent=e.name==="QuotaExceededError"?"存储空间不足，原课程未改动。":e.message;}
    finally{$("importCourse").disabled=false;$("courseFile").value="";}
  };
  render().catch(e=>$("libraryStatus").textContent=e.message);
  if("serviceWorker"in navigator){
    navigator.serviceWorker.register("mobile-sw.js").then(()=>navigator.serviceWorker.ready).then(()=>{
      $("offlineStatus").textContent="离线程序已就绪";
    }).catch(()=>$("offlineStatus").textContent="离线程序未能保存，请联网刷新重试。");
  }
})();
