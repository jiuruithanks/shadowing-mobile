"use strict";
window.TextbookVolume=(()=>{
  const key="textbook-mobile:volume";
  let context,gain;
  const connected=new WeakSet();
  const players=new Set();
  const normalize=value=>Math.max(0,Math.min(100,Math.round(value)));
  function read(){
    try{
      const saved=localStorage.getItem(key);
      if(saved!==null&&Number.isFinite(Number(saved)))return normalize(Number(saved));
    }catch{}
    return 100;
  }
  let level=read();

  function update(){
    if(gain)gain.gain.setTargetAtTime(level/100,context.currentTime,0.01);
    for(const player of players)if(!connected.has(player))player.volume=level/100;
  }

  function getContext(){
    if(!context){
      const AudioContextClass=window.AudioContext||window.webkitAudioContext;
      context=new AudioContextClass();
    }
    return context;
  }

  function prepare(player){
    players.add(player);
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(AudioContextClass){
      try{
        if(!gain){
          getContext();
          gain=context.createGain();
          gain.gain.value=level/100;
          gain.connect(context.destination);
        }
        if(!connected.has(player)){
          const source=context.createMediaElementSource(player);
          source.connect(gain);
          connected.add(player);
          player.volume=1;
        }
        if(context.state!=="running")void context.resume().catch(()=>{});
      }catch{}
    }
    update();
  }

  function createRecordingBoost(player){
    let source,boost,limiter,enabled=false;
    function set(next){
      const audioContext=getContext();
      if(!source){
        boost=audioContext.createGain();
        boost.gain.value=10**(12/20);
        limiter=audioContext.createDynamicsCompressor();
        limiter.threshold.value=-8;
        limiter.knee.value=4;
        limiter.ratio.value=20;
        limiter.attack.value=0.003;
        limiter.release.value=0.15;
        boost.connect(limiter);
        limiter.connect(audioContext.destination);
        source=audioContext.createMediaElementSource(player);
      }else source.disconnect();
      source.connect(next?boost:audioContext.destination);
      enabled=next;
      resume();
    }
    function resume(){
      if(source&&context.state!=="running")void context.resume().catch(()=>{});
    }
    return {set,resume,get enabled(){return enabled;}};
  }

  function addControls(container){
    const controls=document.createElement("div");
    controls.className="textbook-volume";
    const label=document.createElement("label");
    label.textContent="教材播放音量";
    const slider=document.createElement("input");
    slider.type="range";
    slider.min="0";
    slider.max="100";
    slider.step="1";
    slider.setAttribute("aria-label","教材播放音量");
    const value=document.createElement("output");
    const refresh=()=>{slider.value=level;value.textContent=level+"%";};
    slider.oninput=()=>{
      level=normalize(Number(slider.value));
      try{localStorage.setItem(key,String(level));}catch{}
      update();
      refresh();
    };
    window.addEventListener("storage",event=>{
      if(event.key!==key&&event.key!==null)return;
      level=read();
      update();
      refresh();
    });
    window.addEventListener("pageshow",event=>{
      if(!event.persisted)return;
      level=read();
      update();
      refresh();
    });
    label.append(slider,value);
    controls.append(label);
    container.append(controls);
    refresh();
  }
  return {prepare,addControls,createRecordingBoost};
})();
