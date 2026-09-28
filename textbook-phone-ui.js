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
  const menuButton=iconButton("ellipsis","导入与导出");menuButton.id="phoneMenu";header.append(menuButton);
  menuButton.onclick=()=>TextbookTransfer.openHub().catch(error=>notice(error.message));

  const recordings=sheet("本句录音"),row=document.querySelector(".recordings-row");
  const noticeNode=byId("notice");document.querySelector(".playback-panel").append(noticeNode);
  recordings.append(row);
  const player=byId("recordedAudio"),playRecording=iconButton("play","播放我的录音");playRecording.id="phonePlayRecording";
  const updatePlayback=()=>{
    const text=player.paused?"播放我的录音":"暂停我的录音";
    playRecording.replaceChildren();const symbol=document.createElement("i");symbol.dataset.lucide=player.paused?"play":"pause";
    const label=document.createElement("span");label.textContent=text;playRecording.append(symbol,label);
    playRecording.title=text;playRecording.setAttribute("aria-label",text);window.lucide?.createIcons();
  };
  playRecording.onclick=async()=>{
    if(isRecording()){notice("请先停止录音。");return;}
    try{if(player.paused)await player.play();else player.pause();}catch(error){notice("录音暂时无法播放："+error.message);}
  };
  for(const event of ["play","pause","ended","emptied"])player.addEventListener(event,updatePlayback);
  document.querySelector(".playback-panel").append(playRecording);updatePlayback();
  const openRecordings=iconButton("ellipsis","录音下载与删除");openRecordings.id="phoneRecordings";
  document.querySelector(".playback-panel").append(openRecordings);
  openRecordings.onclick=()=>recordings.showModal();
  recordings.addEventListener("close",()=>byId("recordedAudio").pause());
  const updateCount=()=>{
    const n=[...byId("takes").options].filter(o=>o.value).length;
    playRecording.disabled=!n;openRecordings.disabled=!n;
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
