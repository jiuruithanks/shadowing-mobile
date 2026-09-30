"use strict";
window.TextbookCalibration=(()=>{
  let seeding;
  const textOf=sentence=>sentence.text.normalize("NFKC").trim();
  function values(analysis,track){
    return (analysis?.result?.pitch?.moras||[]).map((m,index)=>({index,text:m.text,
      start:track==="reference"?m.time_start:m.recording_start,
      end:track==="reference"?m.time_end:m.recording_end,
      confirmed:track==="reference"?!!m.reference_timing_manual:m.recording_match==="manual",
      discarded:track==="reference"?!!m.reference_timing_discarded:m.recording_match==="discarded"}));
  }
  async function save(take,sentence,analysis,replace=true){
    if(!sentence?.text||!analysis?.result?.pitch?.moras?.length)return;
    for(const track of ["reference","recording"]){
      const moras=values(analysis,track);
      if(!moras.some(m=>m.confirmed||m.discarded))continue;
      let blob=track==="reference"?take.referenceBlob:take.blob;
      if(track==="reference"&&!blob&&analysis.reference?.audio_url){
        const response=await fetch(analysis.reference.audio_url);if(response.ok)blob=await response.blob();
      }
      const duration=analysis.result.audio_data?.[track==="reference"?"reference":"recording_raw"]?.duration;
      if(!blob?.size||!Number.isFinite(duration))continue;
      if(!blob.type.startsWith("audio/"))blob=new Blob([blob],{type:"audio/wav"});
      const audioHash=await ShadowingPackage.sha256Blob(blob),text=textOf(sentence);
      const value={key:JSON.stringify([track,audioHash,text]),track,audioHash,text,lessonId:sentence.lessonId,
        duration,moras,created:analysis.created||take.created,sourceCreated:take.created};
      await TextbookSync.saveCalibration({value,blob},replace);
    }
  }
  async function seed(){
    return seeding||=(async()=>{
      const rows=await TextbookSync.all("recordings"),backups=await TextbookSync.all("syncBackups");
      // Current records win over historical copies of the same audio.
      for(const take of [...rows,...backups.sort((a,b)=>b.created-a.created).flatMap(b=>b.rows||[])])
        if(take.sentence&&take.analysis)await save(take,take.sentence,take.analysis,false);
    })().catch(error=>{seeding=null;throw error;});
  }
  async function find(sentence){
    await seed();const text=textOf(sentence);
    return (await TextbookSync.calibrations()).filter(t=>t.value.text===text);
  }
  function applyReference(analysis,template){
    const result=structuredClone(analysis),moras=result.result?.pitch?.moras||[],source=template.value.moras;
    if(moras.length!==source.length||moras.some((m,i)=>m.text!==source[i].text))return {analysis,count:0};
    let count=0;
    for(const m of source){
      const target=moras[m.index];
      if(target.reference_timing_manual||target.reference_timing_discarded)continue;
      if(m.discarded){Object.assign(target,{time_start:null,time_end:null,reference_timing_discarded:true,reference_timing_manual:false});count++;}
      else if(m.confirmed){Object.assign(target,{time_start:m.start,time_end:m.end,reference_timing_manual:true,reference_timing_discarded:false,timing_source:"saved-reference-calibration",timing_issue:""});count++;}
    }
    for(const m of moras){
      if(m.reference_timing_manual||m.reference_timing_discarded||!Number.isFinite(m.time_start)||!Number.isFinite(m.time_end))continue;
      if(moras.some(other=>other!==m&&other.reference_timing_manual&&m.time_start<other.time_end&&m.time_end>other.time_start))
        Object.assign(m,{time_start:null,time_end:null,reference_timing_discarded:true,timing_issue:"自动区间与已复用的标准音校准重叠，请手动确认"});
    }
    if(count)result.reference_calibration={audioHash:template.value.audioHash,count,created:template.value.created};
    return {analysis:result,count};
  }
  async function reuseReference(take,sentence,analysis){
    if(!take.referenceBlob?.size)return {analysis,count:0};
    const hash=await ShadowingPackage.sha256Blob(take.referenceBlob);
    const templates=await find(sentence),template=templates.find(t=>t.value.track==="reference"&&t.value.audioHash===hash);
    return template?applyReference(analysis,template):{analysis,count:0};
  }
  function buildCandidate(analysis,template,transfer){
    const next=structuredClone(analysis);delete next.previous;delete next.candidate;
    const moras=next.result.pitch.moras;
    if(moras.length!==template.value.moras.length||moras.some((m,i)=>m.text!==template.value.moras[i].text))throw new Error("样本音拍与本句不一致");
    for(const item of transfer.intervals){
      const m=moras[item.index];
      if(m.recording_match==="manual"||m.recording_match==="discarded")continue;
      if(item.start===null||item.end===null){
        Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:item.issue||"样本迁移未定位，请手动设置"});
      }else {
        const missing=["unmatched","uncertain"].includes(m.recording_match);
        Object.assign(m,{recording_start:item.start,recording_end:item.end,recording_match:"estimated",
          recording_timing_source:"calibrated-recording-transfer",recording_timing_issue:missing?"本次文字识别未确认这个音拍，请重点检查迁移位置":item.issue||"根据校准样本迁移，待确认"});
      }
    }
    // Never let an inferred boundary overlap a manually confirmed one.
    for(const m of moras){
      if(m.recording_match==="manual"||!Number.isFinite(m.recording_start)||!Number.isFinite(m.recording_end))continue;
      if(moras.some(other=>other!==m&&other.recording_match==="manual"&&m.recording_start<other.recording_end&&m.recording_end>other.recording_start))
        Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:"迁移区间与本次手动确认重叠，请手动设置"});
    }
    next.result.pitch.mora_timing_method="calibrated_recording_transfer";
    next.result.timing_engine="calibrated_transfer";
    next.recording_template={audioHash:template.value.audioHash,created:template.value.created,sourceCreated:template.value.sourceCreated,
      count:transfer.intervals.length,notice:transfer.notice||""};
    next.created=Date.now();return next;
  }
  function protectCurrentManual(candidate,current){
    const next=structuredClone(candidate),moras=next.result.pitch.moras,old=current.result.pitch;
    if(moras.length!==old.moras.length||moras.some((m,i)=>m.text!==old.moras[i].text))throw new Error("候选音拍与当前分析不一致，请重新迁移");
    for(const [i,m] of old.moras.entries()){
      if(m.reference_timing_manual||m.reference_timing_discarded)for(const field of ["time_start","time_end","reference_timing_manual","reference_timing_discarded","reference_discarded_interval","timing_source","timing_issue"]){
        if(field in m)moras[i][field]=structuredClone(m[field]);else delete moras[i][field];
      }
      if(m.recording_match==="manual"||m.recording_match==="discarded")for(const field of ["recording_start","recording_end","recording_match","recording_discarded_interval","recording_timing_source","recording_timing_issue"]){
        if(field in m)moras[i][field]=structuredClone(m[field]);else delete moras[i][field];
      }
    }
    for(const m of moras)if(m.recording_match==="estimated"&&moras.some(other=>other!==m&&other.recording_match==="manual"&&m.recording_start<other.recording_end&&m.recording_end>other.recording_start))
      Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:"迁移区间与最新手动确认重叠，请手动设置"});
    for(const m of moras)if(!m.reference_timing_manual&&!m.reference_timing_discarded&&Number.isFinite(m.time_start)&&moras.some(other=>other!==m&&other.reference_timing_manual&&m.time_start<other.time_end&&m.time_end>other.time_start))
      Object.assign(m,{time_start:null,time_end:null,reference_timing_discarded:true,timing_issue:"自动区间与最新标准音校准重叠，请手动设置"});
    next.result.pitch.manual_history=structuredClone(old.manual_history||[]);
    next.result.pitch.manual_revision=old.manual_revision||0;
    return next;
  }
  async function transfer(take,analysis,template){
    const data=new FormData();
    data.append("sample",template.blob,"sample.wav");data.append("audio",take.blob,"recording.webm");
    data.append("moras",JSON.stringify(template.value.moras));
    const response=await fetch("/api/audio/mora-transfer",{method:"POST",body:data});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"校准样本迁移失败");
    return buildCandidate(analysis,template,result);
  }
  return {save,seed,find,reuseReference,applyReference,buildCandidate,protectCurrentManual,transfer};
})();
