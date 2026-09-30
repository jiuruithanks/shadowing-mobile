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
        exerciseId:sentence.exerciseId,sentenceIndex:sentence.index,duration,moras,created:analysis.created||take.created,sourceCreated:take.created};
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
  function commonRuns(source,target){
    if(source.length&&source.length===target.length&&source.every((m,i)=>m.text===target[i].text))return [{source:0,target:0,length:source.length}];
    const candidates=[];let previous=new Uint16Array(target.length+1);
    for(let i=0;i<source.length;i++){
      const next=new Uint16Array(target.length+1);
      for(let j=0;j<target.length;j++)if(source[i].text===target[j].text){
        const length=next[j+1]=previous[j]+1;
        if(length>=3&&(i===source.length-1||j===target.length-1||source[i+1].text!==target[j+1].text))candidates.push({source:i-length+1,target:j-length+1,length});
      }
      previous=next;
    }
    const occurrences=(sequence,run)=>{
      let count=0;const fragment=source.slice(run.source,run.source+run.length);
      for(let i=0;i<=sequence.length-run.length;i++)if(fragment.every((m,j)=>m.text===sequence[i+j].text)&&++count>1)return count;
      return count;
    };
    const chosen=[];
    // Repeated phrases need the user's choice; never guess which occurrence.
    for(const run of candidates.sort((a,b)=>b.length-a.length||a.source-b.source)){
      if(occurrences(source,run)!==1||occurrences(target,run)!==1)continue;
      if(chosen.some(p=>!(run.source+run.length<=p.source&&run.target+run.length<=p.target||p.source+p.length<=run.source&&p.target+p.length<=run.target)))continue;
      chosen.push(run);
      if(chosen.length===32)break;
    }
    return chosen.sort((a,b)=>a.target-b.target);
  }
  function variantPlan(analysis,template){
    const reference=template.value.track==="reference",target=analysis?.result?.pitch?.moras||[],source=template.value.moras;
    const plans=[];
    for(const run of commonRuns(source,target)){
      const pairs=Array.from({length:run.length},(_,i)=>({source:run.source+i,target:run.target+i}))
        .filter(p=>source[p.source].confirmed&&!source[p.source].discarded);
      if(!pairs.length)continue;
      const first=pairs[0],last=pairs.at(-1),a=target[first.target],b=target[last.target];
      const start=reference?a.time_start:a.recording_start,end=reference?b.time_end:b.recording_end;
      if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.08)continue;
      plans.push({source_start:source[first.source].start,source_end:source[last.source].end,target_start:start,target_end:end,pairs});
    }
    return plans;
  }
  async function variants(sentence,analysis,texts,exerciseIds=[]){
    return (await sectionTemplates(sentence.lessonId,texts,exerciseIds)).filter(t=>t.value.sourceCreated!==sentence.sourceCreated)
      .map(template=>({template,plans:variantPlan(analysis,template)}));
  }
  async function sectionTemplates(lessonId,texts,exerciseIds=[]){
    await seed();const allowed=new Set(texts.map(text=>text.normalize("NFKC").trim()));
    return (await TextbookSync.calibrations()).filter(t=>t.value.lessonId===lessonId&&(t.value.exerciseId?exerciseIds.length?exerciseIds.includes(t.value.exerciseId):allowed.has(t.value.text):allowed.has(t.value.text))&&t.value.moras.some(m=>m.confirmed));
  }
  function manualPlan(analysis,template,from,to,targetFrom,targetTo,start,end){
    const source=template.value.moras,target=analysis.result.pitch.moras;
    if(![from,to,targetFrom,targetTo].every(Number.isInteger)||from<0||to<from||to>=source.length||targetFrom<0||targetTo<targetFrom||targetTo>=target.length)throw new Error("请选择有效的音拍范围");
    if(to-from!==targetTo-targetFrom||source.slice(from,to+1).some((m,i)=>m.text!==target[targetFrom+i].text))throw new Error("两边所选假名不一致，请选择相同的发音片段；不同内容不能套用音拍");
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<.08)throw new Error("请设置本句片段的开始和结束时间，至少间隔 0.08 秒");
    const pairs=Array.from({length:to-from+1},(_,i)=>({source:from+i,target:targetFrom+i})).filter(p=>source[p.source].confirmed&&!source[p.source].discarded);
    if(!pairs.length)throw new Error("来源片段没有手动确认的音拍");
    if(!Number.isFinite(source[from].start)||!Number.isFinite(source[to].end)||source[to].end-source[from].start<.08)throw new Error("来源片段的首尾边界尚未定位");
    return [{source_start:source[from].start,source_end:source[to].end,target_start:start,target_end:end,pairs}];
  }
  function automaticSelections(entries,analysis){
    const selected=[],used={reference:new Set(),recording:new Set()},moras=analysis.result.pitch.moras;
    const ranked=[...entries].sort((a,b)=>b.plans.reduce((n,p)=>n+p.pairs.length,0)-a.plans.reduce((n,p)=>n+p.pairs.length,0)||b.template.value.created-a.template.value.created);
    for(const entry of ranked){
      const track=entry.template.value.track,plans=[];
      for(const plan of entry.plans){
        const pairs=plan.pairs.filter(p=>!used[track].has(p.target)&&!(track==="reference"?moras[p.target].reference_timing_manual||moras[p.target].reference_timing_discarded:["manual","discarded"].includes(moras[p.target].recording_match)));
        if(!pairs.length)continue;
        pairs.forEach(p=>used[track].add(p.target));plans.push({...plan,pairs});
      }
      if(plans.length)selected.push({...entry,plans});
    }
    return selected;
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
  function buildVariantCandidate(analysis,template,plans,result,automatic=false){
    const next=structuredClone(analysis);delete next.previous;delete next.candidate;
    const reference=template.value.track==="reference",moras=next.result.pitch.moras;
    const pairs=new Map(plans.flatMap(p=>p.pairs).map(p=>[p.source,p.target]));let count=0;
    for(const item of result.intervals){
      const index=pairs.get(item.index),m=moras[index];if(!m||item.start===null||item.end===null)continue;
      if(automatic&&item.issue&&item.issue!=="根据校准样本迁移，待确认")continue;
      if(reference?m.reference_timing_manual||m.reference_timing_discarded:["manual","discarded"].includes(m.recording_match))continue;
      const overlap=moras.some((other,i)=>i!==index&&(reference?other.reference_timing_manual:other.recording_match==="manual")&&item.start<(reference?other.time_end:other.recording_end)&&item.end>(reference?other.time_start:other.recording_start));
      if(overlap)continue;
      if(reference)Object.assign(m,{time_start:item.start,time_end:item.end,reference_timing_manual:false,reference_timing_discarded:false,timing_source:"variant-calibration-transfer",timing_issue:"替换句共同部分迁移，待核对"});
      else Object.assign(m,{recording_start:item.start,recording_end:item.end,recording_match:"estimated",recording_timing_source:"calibrated-recording-transfer",recording_timing_issue:"替换句共同部分迁移，待核对"});
      count++;
    }
    if(!count)throw new Error("共同部分没有可迁移的音拍，或与本次手动修订冲突");
    next.variant_template={track:template.value.track,text:template.value.text,count,audioHash:template.value.audioHash};
    next.created=Date.now();return next;
  }
  async function transferVariant(take,analysis,template,selectedPlans=null,automatic=false){
    const plans=selectedPlans||variantPlan(analysis,template);
    if(!plans.length)throw new Error("共同部分缺少可用的定位区间，请先完成本句分析");
    let blob=template.value.track==="reference"?take.referenceBlob:take.blob;
    if(!blob&&template.value.track==="reference"&&analysis.reference?.audio_url){
      const response=await fetch(analysis.reference.audio_url);if(response.ok)blob=await response.blob();
    }
    if(!blob?.size)throw new Error("本句音频不可用");
    const data=new FormData();data.append("sample",template.blob,"sample.wav");data.append("audio",blob,"target.wav");
    data.append("moras",JSON.stringify(template.value.moras));data.append("segments",JSON.stringify(plans.map(p=>({...p,indices:p.pairs.map(pair=>pair.source),pairs:undefined}))));
    const response=await fetch("/api/audio/mora-transfer",{method:"POST",body:data});const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"替换句校准复用失败");
    if(result.scope!=="segments")throw new Error("本地服务尚未更新，请退出并重新打开日语跟读 App；当前校准未改动");
    return buildVariantCandidate(analysis,template,plans,result,automatic);
  }
  return {save,seed,find,reuseReference,applyReference,buildCandidate,protectCurrentManual,transfer,commonRuns,variantPlan,variants,sectionTemplates,buildVariantCandidate,transferVariant,manualPlan,automaticSelections};
})();
