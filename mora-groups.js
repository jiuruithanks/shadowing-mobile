"use strict";
window.MoraGroups=(()=>{
  const valid=span=>span&&Number.isFinite(span.start)&&Number.isFinite(span.end)&&span.start>=0&&span.end>span.start;
  function groups(pitch){return pitch?.mora_groups||[];}
  function group(pitch,index){return groups(pitch).find(g=>index>=g.start_index&&index<=g.end_index);}
  function units(pitch){
    const result=[];
    for(let index=0;index<(pitch?.moras?.length||0);index++){
      const joined=group(pitch,index);if(joined&&joined.start_index!==index)continue;
      const end_index=joined?.end_index??index;
      result.push({index,end_index,group:joined,text:pitch.moras.slice(index,end_index+1).map(m=>m.text).join("")});
    }
    return result;
  }
  function interval(pitch,index,track){
    const joined=group(pitch,index);
    if(joined)return valid(joined[track])&&!joined[track].discarded?joined[track]:null;
    const m=pitch?.moras?.[index],span=pitch?.mora_spans?.find(s=>s.index===index);
    if(!m||(track==="reference"?m.reference_timing_discarded:m.recording_match==="discarded"))return null;
    const start=track==="reference"?m.time_start:m.recording_start===undefined?span?.recording_start:m.recording_start;
    const end=track==="reference"?m.time_end:m.recording_end===undefined?span?.recording_end:m.recording_end;
    return valid({start,end})?{start,end}:null;
  }
  function info(pitch,index,track){
    const joined=group(pitch,index),m=pitch?.moras?.[index];
    return joined?{manual:!!joined[track]?.manual,discarded:!!joined[track]?.discarded,issue:joined[track]?.issue||"",source:joined[track]?.source||""}
      :{manual:track==="reference"?!!m?.reference_timing_manual:m?.recording_match==="manual",discarded:track==="reference"?!!m?.reference_timing_discarded:m?.recording_match==="discarded",issue:track==="reference"?m?.timing_issue:m?.recording_timing_issue,source:track==="reference"?m?.timing_source:m?.recording_timing_source};
  }
  function merge(pitch,from,to){
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>=pitch.moras.length||to<=from)throw new Error("请选择连续两个或多个音拍");
    let start=from,end=to;
    for(const g of groups(pitch))if(g.start_index<=end&&g.end_index>=start){start=Math.min(start,g.start_index);end=Math.max(end,g.end_index);}
    const existing=groups(pitch).find(g=>g.start_index===start&&g.end_index===end);if(existing)return existing;
    const joined={start_index:start,end_index:end,hidden_pauses:{}};
    for(const track of ["reference","recording"]){
      const a=interval(pitch,start,track),b=interval(pitch,end,track),members=units(pitch).filter(u=>u.index>=start&&u.end_index<=end);
      joined[track]=a&&b&&b.end>a.start?{start:a.start,end:b.end,manual:members.every(u=>info(pitch,u.index,track).manual),edited:members.some(u=>u.group?.[track]?.edited),issue:""}:null;
      joined.hidden_pauses[track]=[...(pitch.pause_intervals?.[track]||[]).filter(p=>p.after_index>=start&&p.after_index<end),
        ...groups(pitch).filter(g=>g.start_index>=start&&g.end_index<=end).flatMap(g=>g.hidden_pauses?.[track]||[])];
      if(pitch.pause_intervals?.[track])pitch.pause_intervals[track]=pitch.pause_intervals[track].filter(p=>p.after_index<start||p.after_index>=end);
    }
    pitch.mora_groups=[...groups(pitch).filter(g=>g.end_index<start||g.start_index>end),joined].sort((a,b)=>a.start_index-b.start_index);
    return joined;
  }
  function ensure(pitch,from,to){
    const same=groups(pitch).find(g=>g.start_index===from&&g.end_index===to);if(same)return same;
    if(groups(pitch).some(g=>g.start_index<=to&&g.end_index>=from))return null;
    return merge(pitch,from,to);
  }
  function split(pitch,index){
    const joined=group(pitch,index);if(!joined)throw new Error("当前音拍未合并");
    for(const track of ["reference","recording"]){
      const span=joined[track];
      if(span?.edited){
        const reference=track==="reference";
        for(let i=joined.start_index;i<=joined.end_index;i++){
          const m=pitch.moras[i];
          if(reference){m.reference_timing_manual=false;m.reference_timing_discarded=false;m.timing_issue="合并区间已调整，内部边界待确认";}
          else {m.recording_match="uncertain";m.recording_timing_issue="合并区间已调整，内部边界待确认";}
          const a=reference?"time_start":"recording_start",b=reference?"time_end":"recording_end";
          if(i===joined.start_index)m[a]=valid(span)?span.start:null;
          if(i===joined.end_index)m[b]=valid(span)?span.end:null;
          if(!valid(span)){m[a]=null;m[b]=null;}
          else {
            if(!Number.isFinite(m[a])||m[a]<span.start||m[a]>=span.end)m[a]=null;
            if(!Number.isFinite(m[b])||m[b]>span.end||m[b]<=span.start)m[b]=null;
            if(Number.isFinite(m[a])&&Number.isFinite(m[b])&&m[b]<=m[a]){if(i===joined.start_index)m[b]=null;else if(i===joined.end_index)m[a]=null;else {m[a]=null;m[b]=null;}}
          }
        }
      }else if(joined.hidden_pauses?.[track]?.length){
        pitch.pause_intervals ||= {};pitch.pause_intervals[track]=[...(pitch.pause_intervals[track]||[]),...joined.hidden_pauses[track]].sort((a,b)=>a.start-b.start);
      }
    }
    pitch.mora_groups=groups(pitch).filter(g=>g!==joined);
    rebuild(pitch);
  }
  function rebuild(pitch){
    const previous=pitch.mora_spans||[];
    pitch.mora_spans=units(pitch).flatMap(u=>{
      const a=interval(pitch,u.index,"reference"),b=interval(pitch,u.index,"recording");
      const existing=u.group?{}:{...previous.find(s=>s.index===u.index&&!s.end_index)};
      return a&&b?[{...existing,index:u.index,...(u.group?{end_index:u.end_index}:{}),reference_start:a.start,reference_end:a.end,recording_start:b.start,recording_end:b.end}]:[];
    });
  }
  function display(pitch){return units(pitch).map(u=>{
    const m={...pitch.moras[u.index],text:u.text,index:u.index,end_index:u.end_index};
    if(!u.group)return m;
    const a=interval(pitch,u.index,"reference"),b=interval(pitch,u.index,"recording"),ai=info(pitch,u.index,"reference"),bi=info(pitch,u.index,"recording");
    return {...m,time_start:a?.start??null,time_end:a?.end??null,reference_timing_manual:ai.manual,reference_timing_discarded:ai.discarded,
      timing_issue:ai.issue,timing_source:ai.source,recording_start:b?.start??null,recording_end:b?.end??null,
      recording_match:bi.discarded?"discarded":bi.manual?"manual":b?"estimated":"uncertain",recording_timing_issue:bi.issue,recording_timing_source:bi.source};
  });}
  function calibrationGroups(pitch,track){return groups(pitch).map(g=>({start_index:g.start_index,end_index:g.end_index,
    start:interval(pitch,g.start_index,track)?.start??null,end:interval(pitch,g.start_index,track)?.end??null,
    confirmed:info(pitch,g.start_index,track).manual,discarded:info(pitch,g.start_index,track).discarded}));}
  function transferValues(value){
    const result=structuredClone(value.moras);
    for(const g of value.groups||[])for(let i=g.start_index;i<=g.end_index;i++){
      Object.assign(result[i],i===g.start_index?{start:g.start,end:g.end,confirmed:g.confirmed,discarded:g.discarded,end_index:g.end_index}
        :{start:null,end:null,confirmed:false,discarded:false});
    }
    return result;
  }
  const confirmed=value=>value.moras.some(m=>m.confirmed)||(value.groups||[]).some(g=>g.confirmed);
  function write(pitch,index,track,span){
    const joined=group(pitch,index);
    if(joined){joined[track]={...span};return;}
    const m=pitch.moras[index];
    if(track==="reference")Object.assign(m,{time_start:span.start,time_end:span.end,reference_timing_manual:!!span.manual,reference_timing_discarded:!!span.discarded,timing_issue:span.issue||"",timing_source:span.source||""});
    else Object.assign(m,{recording_start:span.start,recording_end:span.end,recording_match:span.discarded?"discarded":span.manual?"manual":valid(span)?"estimated":"uncertain",recording_timing_issue:span.issue||"",recording_timing_source:span.source||""});
  }
  return {valid,groups,group,units,interval,info,merge,ensure,split,rebuild,display,calibrationGroups,transferValues,confirmed,write};
})();
