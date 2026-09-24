"use strict";
document.addEventListener("DOMContentLoaded",()=>{
  const byId=id=>document.getElementById(id);
  const iconButton=(icon,label)=>{
    const button=document.createElement("button");button.className="icon-button";
    button.title=label;button.setAttribute("aria-label",label);
    const symbol=document.createElement("i");symbol.dataset.lucide=icon;button.append(symbol);return button;
  };
  const sheet=title=>{
    const dialog=document.createElement("dialog");dialog.className="phone-sheet";
    const bar=document.createElement("div");bar.className="dialog-toolbar";
    const heading=document.createElement("strong");heading.textContent=title;
    const close=iconButton("x","关闭");close.onclick=()=>dialog.close();bar.append(heading,close);dialog.append(bar);
    document.body.append(dialog);return dialog;
  };
  const header=document.querySelector(".app-header");
  const menu=sheet("教材与同步"),menuButton=iconButton("ellipsis","教材与同步");
  menuButton.id="phoneMenu";header.append(menuButton);menuButton.onclick=()=>menu.showModal();
  const library=document.createElement("a");library.href="mobile-textbook-library.html";library.textContent="教材库";menu.append(library);
  const exportButton=document.createElement("button");exportButton.textContent="导出全部练习到电脑";
  const status=document.createElement("p");status.setAttribute("role","status");
  exportButton.onclick=async()=>{
    exportButton.disabled=true;status.textContent="正在打包全部课程的录音、笔记、标记和进度…";
    try{await TextbookTransfer.exportPractice();status.textContent="练习包已导出，请在电脑的文件菜单中选择“导入手机练习记录”。";}
    catch(error){status.textContent=error.message;}finally{exportButton.disabled=false;}
  };
  menu.append(exportButton,status);
  const variants=document.createElement("button");variants.textContent="同步时保留的笔记与回答";
  variants.onclick=()=>{menu.close();TextbookTransfer.variantsDialog();};
  menu.addEventListener("close",()=>status.textContent="");
  menuButton.addEventListener("click",()=>{
    const hasVariants=state.lessons.some(l=>l.items.some(i=>["note:","answer:"].some(p=>read("importedVariants:"+p+i.id,"[]")!=="[]")));
    variants.hidden=!hasVariants;
  });menu.append(variants);

  const recordings=sheet("本句录音"),row=document.querySelector(".recordings-row");
  const noticeNode=byId("notice");document.querySelector(".playback-panel").append(noticeNode);
  recordings.append(row);
  const openRecordings=iconButton("headphones","本句录音");openRecordings.id="phoneRecordings";
  const count=document.createElement("span");openRecordings.append(count);
  document.querySelector(".playback-panel").append(openRecordings);
  openRecordings.onclick=()=>recordings.showModal();
  recordings.addEventListener("close",()=>byId("recordedAudio").pause());
  const updateCount=()=>{
    const n=[...byId("takes").options].filter(o=>o.value).length;
    count.textContent=`录音 ${n} 条`;openRecordings.title=`本句录音 ${n} 条`;
    openRecordings.setAttribute("aria-label",`本句录音 ${n} 条`);
  };
  new MutationObserver(updateCount).observe(byId("takes"),{childList:true});updateCount();
  const updateNav=()=>{
    const open=document.body.classList.contains("nav-open");
    document.querySelector(".practice").inert=open;
    byId("navToggle").title=open?"关闭目录":"练习目录";
    byId("navToggle").setAttribute("aria-label",open?"关闭目录":"练习目录");
  };
  new MutationObserver(updateNav).observe(document.body,{attributes:true,attributeFilter:["class"]});updateNav();
  document.addEventListener("keydown",event=>{if(event.key==="Escape"){document.body.classList.remove("nav-open");byId("navToggle").setAttribute("aria-expanded","false");}});
  new ResizeObserver(()=>document.documentElement.style.setProperty("--phone-header",header.offsetHeight+"px")).observe(header);
  window.lucide?.createIcons();
});
