"use strict";
window.TextbookCalibration=(()=>{
  let seeding;
  const textOf=sentence=>sentence.text.normalize("NFKC").trim();
  async function readAudio(take,analysis,track){
    const reference=track==="reference",stored=reference?
      window.TextbookSync?.referenceAudio?await TextbookSync.referenceAudio(take,analysis):take.referenceBlob:take.blob;
    // Materialize file-backed IndexedDB blobs before hashing or multipart upload.
    const materialize=async blob=>{
      if(!blob?.size)throw new Error("音频为空");
      const bytes=await blob.arrayBuffer();
      if(bytes.byteLength!==blob.size)throw new Error("音频读取不完整");
      return new Blob([bytes],{type:blob.type||"audio/wav"});
    };
    if(stored)try{return await materialize(stored);}catch{}
    const urls=[];
    if(reference){
      const filename=analysis?.reference?.filename;
      if(/^reference-[0-9a-f]{24,64}\.wav$/.test(filename||""))urls.push("/media/reference/"+filename);
    }else{
      const id=analysis?.result?.recording_id;
      if(/^[0-9a-f]{32}$/.test(id||"")){
        const ext=stored?.type.includes("mp4")?"m4a":stored?.type.includes("wav")?"wav":"webm";
        urls.push(`/media/recordings/${id}-source.${ext}`,`/media/recordings/${id}.wav`);
      }
    }
    const url=reference?analysis?.reference?.audio_url:analysis?.result?.recording_url;
    if(url){const parsed=new URL(url,location.href);if(parsed.origin===location.origin&&parsed.pathname.startsWith(reference?"/media/reference/":"/media/recordings/"))urls.push(parsed.pathname);}
    for(const url of [...new Set(urls)])try{
      const response=await fetch(url);if(response.ok)return await materialize(await response.blob());
    }catch{}
    throw new Error((reference?"标准音频":"这条录音")+"无法读取，本机音频副本也不可用。原分析和手动调整未改动，请勿清除网站数据。");
  }
  function values(analysis,track){
    const pitch=analysis?.result?.pitch;
    return (pitch?.moras||[]).map((m,index)=>({index,text:m.text,
      start:track==="reference"?m.time_start:m.recording_start,
      end:track==="reference"?m.time_end:m.recording_end,
      confirmed:!MoraGroups.group(pitch,index)&&(track==="reference"?!!m.reference_timing_manual:m.recording_match==="manual"),
      discarded:!MoraGroups.group(pitch,index)&&(track==="reference"?!!m.reference_timing_discarded:m.recording_match==="discarded")}));
  }
  async function save(take,sentence,analysis,replace=true){
    if(!sentence?.text||!analysis?.result?.pitch?.moras?.length)return;
    const errors=[];
    for(const track of ["reference","recording"]){
      try{
      const moras=values(analysis,track);
      const pitch=analysis.result.pitch;
      const editedAt=pitch.calibration_edits?.[track]||Math.max(0,...(pitch.manual_history||[]).filter(h=>h.track===track).map(h=>h.created||0));
      const groups=MoraGroups.calibrationGroups(pitch,track);
      if(!moras.some(m=>m.confirmed||m.discarded)&&!groups.some(g=>g.confirmed||g.discarded)&&!editedAt)continue;
      let blob=await readAudio(take,analysis,track);
      const duration=analysis.result.audio_data?.[track==="reference"?"reference":"recording_raw"]?.duration;
      if(!blob?.size||!Number.isFinite(duration))continue;
      if(!blob.type.startsWith("audio/"))blob=new Blob([blob],{type:"audio/wav"});
      const audioHash=await ShadowingPackage.sha256Blob(blob),text=textOf(sentence);
      const value={key:JSON.stringify([track,audioHash,text]),track,audioHash,text,lessonId:sentence.lessonId,
        referenceKind:analysis.reference?.kind||"original",referenceVoice:referenceVoice(analysis),
        exerciseId:sentence.exerciseId,sentenceIndex:sentence.index,duration,moras,groups,pauses:structuredClone(pitch.pause_intervals?.[track]||[]),created:analysis.created||take.created,updated:editedAt||analysis.created||take.created,sourceCreated:take.created};
      await TextbookSync.saveCalibration({value,blob},replace);
      }catch(error){errors.push((track==="reference"?"标准音":"我的录音")+"："+error.message);}
    }
    if(errors.length)throw new Error(errors.join("；"));
  }
  async function seed(){
    return seeding||=(async()=>{
      const rows=await TextbookSync.all("recordings"),backups=await TextbookSync.all("syncBackups");
      // Current records win over historical copies of the same audio.
      for(const take of rows)
        if(take.sentence&&take.analysis)await save(take,take.sentence,take.analysis,true).catch(error=>console.warn("Calibration recovery",error));
      for(const take of backups.sort((a,b)=>b.created-a.created).flatMap(b=>b.rows||[]))
        if(take.sentence&&take.analysis)await save(take,take.sentence,take.analysis,false).catch(error=>console.warn("Calibration backup recovery",error));
    })().catch(error=>{seeding=null;throw error;});
  }
  function referenceVoice(analysis){return JSON.stringify([analysis?.reference?.profile_id,analysis?.reference?.diffusion_steps,analysis?.reference?.cfg_rate]);}
  function matchingReference(template,analysis){
    if(!analysis||template.value.track!=="reference")return true;
    const kind=analysis.reference?.kind||"original";
    return (template.value.referenceKind||"original")===kind&&(kind!=="my-voice"||template.value.referenceVoice===referenceVoice(analysis));
  }
  async function find(sentence,analysis=null){
    await seed();const text=textOf(sentence);
    return (await TextbookSync.calibrations()).filter(t=>t.value.text===text&&matchingReference(t,analysis));
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
      const pairs=calibrationPairs(template.value,run.source,run.source+run.length-1,run.target);
      if(!pairs.length)continue;
      const first=pairs[0],last=pairs.at(-1),track=reference?"reference":"recording";
      const start=MoraGroups.interval(analysis.result.pitch,first.target,track)?.start,end=MoraGroups.interval(analysis.result.pitch,last.target_end??last.target,track)?.end;
      if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.08)continue;
      const transferred=MoraGroups.transferValues(template.value);
      plans.push({source_start:transferred[first.source].start,source_end:transferred[last.source].end,target_start:start,target_end:end,pairs});
    }
    return plans;
  }
  async function variants(sentence,analysis,texts,exerciseIds=[]){
    return (await sectionTemplates(sentence.lessonId,texts,exerciseIds)).filter(t=>t.value.sourceCreated!==sentence.sourceCreated&&matchingReference(t,analysis))
      .map(template=>({template,plans:variantPlan(analysis,template)}));
  }
  async function sectionTemplates(lessonId,texts,exerciseIds=[]){
    await seed();const allowed=new Set(texts.map(text=>text.normalize("NFKC").trim()));
    return (await TextbookSync.calibrations()).filter(t=>t.value.lessonId===lessonId&&(t.value.exerciseId?exerciseIds.length?exerciseIds.includes(t.value.exerciseId):allowed.has(t.value.text):allowed.has(t.value.text))&&MoraGroups.confirmed(t.value));
  }
  function manualPlan(analysis,template,from,to,targetFrom,targetTo,start,end){
    const source=template.value.moras,target=analysis.result.pitch.moras;
    if(![from,to,targetFrom,targetTo].every(Number.isInteger)||from<0||to<from||to>=source.length||targetFrom<0||targetTo<targetFrom||targetTo>=target.length)throw new Error("请选择有效的音拍范围");
    if(to-from!==targetTo-targetFrom||source.slice(from,to+1).some((m,i)=>m.text!==target[targetFrom+i].text))throw new Error("两边所选假名不一致，请选择相同的发音片段；不同内容不能套用音拍");
    if(start===undefined&&end===undefined){
      const reference=template.value.track==="reference";
      start=MoraGroups.interval(analysis.result.pitch,targetFrom,reference?"reference":"recording")?.start;
      end=MoraGroups.interval(analysis.result.pitch,targetTo,reference?"reference":"recording")?.end;
      if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.08)throw new Error("本句所选片段尚无有效定位，请先在波形中校准首尾音拍。");
    }
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<.08)throw new Error("请设置本句片段的开始和结束时间，至少间隔 0.08 秒");
    const pairs=calibrationPairs(template.value,from,to,targetFrom);
    if(!pairs.length)throw new Error("来源片段没有手动确认的音拍");
    const first=pairs[0],last=pairs.at(-1),transferred=MoraGroups.transferValues(template.value);
    if(!Number.isFinite(transferred[first.source].start)||!Number.isFinite(transferred[last.source].end)||transferred[last.source].end-transferred[first.source].start<.08)throw new Error("来源片段的首尾边界尚未定位");
    return [{source_start:transferred[first.source].start,source_end:transferred[last.source].end,target_start:start,target_end:end,pairs}];
  }
  function calibrationPairs(value,from,to,targetFrom){
    const result=[];
    for(let index=from;index<=to;index++){
      const joined=(value.groups||[]).find(g=>index>=g.start_index&&index<=g.end_index);
      if(joined){
        if(index!==joined.start_index||joined.end_index>to||!joined.confirmed||joined.discarded)continue;
        result.push({source:index,target:targetFrom+index-from,source_end:joined.end_index,target_end:targetFrom+joined.end_index-from});
      }else if(value.moras[index].confirmed&&!value.moras[index].discarded)result.push({source:index,target:targetFrom+index-from});
    }
    return result;
  }
  function automaticSelections(entries,analysis){
    const selected=[],used={reference:new Set(),recording:new Set()},moras=analysis.result.pitch.moras;
    const ranked=[...entries].sort((a,b)=>b.plans.reduce((n,p)=>n+p.pairs.length,0)-a.plans.reduce((n,p)=>n+p.pairs.length,0)||b.template.value.created-a.template.value.created);
    for(const entry of ranked){
      const track=entry.template.value.track,plans=[];
      for(const plan of entry.plans){
        const pairs=plan.pairs.filter(p=>{
          for(let i=p.target;i<=(p.target_end??p.target);i++){const info=MoraGroups.info(analysis.result.pitch,i,track);if(used[track].has(i)||info.manual||info.discarded)return false;}
          return true;
        });
        if(!pairs.length)continue;
        pairs.forEach(p=>{for(let i=p.target;i<=(p.target_end??p.target);i++)used[track].add(i);});plans.push({...plan,pairs});
      }
      if(plans.length)selected.push({...entry,plans});
    }
    return selected;
  }
  function canAdoptGroup(pitch,start,end,track){
    const existing=MoraGroups.group(pitch,start);
    if(existing?.start_index===start&&existing.end_index===end)return true;
    for(let i=start;i<=end;i++){const info=MoraGroups.info(pitch,i,track);if(info.manual||info.discarded)return false;}
    return true;
  }
  function applyReference(analysis,template){
    const result=structuredClone(analysis),moras=result.result?.pitch?.moras||[],source=template.value.moras;
    if(moras.length!==source.length||moras.some((m,i)=>m.text!==source[i].text))return {analysis,count:0};
    let count=0;
    for(const saved of template.value.groups||[]){
      if(!canAdoptGroup(result.result.pitch,saved.start_index,saved.end_index,"reference"))continue;
      const joined=MoraGroups.ensure(result.result.pitch,saved.start_index,saved.end_index);if(!joined||joined.reference?.manual)continue;
      if(saved.confirmed||saved.discarded){joined.reference={start:saved.start,end:saved.end,manual:saved.confirmed,discarded:saved.discarded,edited:true,source:"saved-reference-calibration",issue:""};count+=saved.end_index-saved.start_index+1;}
    }
    for(const m of source){
      if(MoraGroups.group(result.result.pitch,m.index))continue;
      const target=moras[m.index];
      if(target.reference_timing_manual||target.reference_timing_discarded)continue;
      if(m.discarded){Object.assign(target,{time_start:null,time_end:null,reference_timing_discarded:true,reference_timing_manual:false});count++;}
      else if(m.confirmed){Object.assign(target,{time_start:m.start,time_end:m.end,reference_timing_manual:true,reference_timing_discarded:false,timing_source:"saved-reference-calibration",timing_issue:""});count++;}
    }
    for(const m of moras){
      if(MoraGroups.group(result.result.pitch,moras.indexOf(m)))continue;
      if(m.reference_timing_manual||m.reference_timing_discarded||!Number.isFinite(m.time_start)||!Number.isFinite(m.time_end))continue;
      if(moras.some(other=>other!==m&&other.reference_timing_manual&&m.time_start<other.time_end&&m.time_end>other.time_start))
        Object.assign(m,{time_start:null,time_end:null,reference_timing_discarded:true,timing_issue:"自动区间与已复用的标准音校准重叠，请手动确认"});
    }
    if(count)result.reference_calibration={audioHash:template.value.audioHash,count,created:template.value.created};
    if(template.value.pauses?.length&&!result.result.pitch.pause_intervals?.reference?.length){
      result.result.pitch.pause_intervals ||= {};
      result.result.pitch.pause_intervals.reference=structuredClone(template.value.pauses.filter(p=>
        Math.abs(MoraGroups.interval(result.result.pitch,p.after_index,"reference")?.end-p.start)<.000001&&Math.abs(MoraGroups.interval(result.result.pitch,p.after_index+1,"reference")?.start-p.end)<.000001));
    }
    if(MoraGroups.groups(result.result.pitch).length)MoraGroups.rebuild(result.result.pitch);
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
      const saved=(template.value.groups||[]).find(g=>g.start_index===item.index);
      if(saved){
        if(!canAdoptGroup(next.result.pitch,saved.start_index,saved.end_index,"recording"))continue;
        const joined=MoraGroups.ensure(next.result.pitch,saved.start_index,saved.end_index);if(!joined||joined.recording?.manual||joined.recording?.discarded)continue;
        const duration=next.result.audio_data?.recording_raw?.duration;
        const valid=MoraGroups.valid(item)&&(!Number.isFinite(duration)||item.end<=duration+.01);
        joined.recording={start:valid?item.start:null,end:valid?item.end:null,manual:false,edited:true,source:"calibrated-recording-transfer",issue:item.issue||(valid?"根据校准样本迁移，待确认":"整组迁移未定位，请手动设置")};continue;
      }
      if(MoraGroups.group(next.result.pitch,item.index))continue;
      const m=moras[item.index];
      if(!m)continue;
      if(m.recording_match==="manual"||m.recording_match==="discarded")continue;
      if(!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.start<0||item.end<=item.start){
        Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:item.issue||"样本迁移未定位，请手动设置"});
      }else {
        const missing=["unmatched","uncertain"].includes(m.recording_match);
        Object.assign(m,{recording_start:item.start,recording_end:item.end,recording_match:"estimated",
          recording_timing_source:"calibrated-recording-transfer",recording_timing_issue:missing?"本次文字识别未确认这个音拍，请重点检查迁移位置":item.issue||"根据校准样本迁移，待确认"});
      }
    }
    // Never let an inferred boundary overlap a manually confirmed one.
    for(const m of moras){
      if(MoraGroups.group(next.result.pitch,moras.indexOf(m)))continue;
      if(m.recording_match==="manual"||!Number.isFinite(m.recording_start)||!Number.isFinite(m.recording_end))continue;
      if(moras.some(other=>other!==m&&other.recording_match==="manual"&&m.recording_start<other.recording_end&&m.recording_end>other.recording_start))
        Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:"迁移区间与本次手动确认重叠，请手动设置"});
    }
    next.result.pitch.mora_timing_method="calibrated_recording_transfer";
    next.result.timing_engine="calibrated_transfer";
    next.recording_template={audioHash:template.value.audioHash,created:template.value.created,sourceCreated:template.value.sourceCreated,
      count:transfer.intervals.length,notice:transfer.notice||""};
    if(MoraGroups.groups(next.result.pitch).length)MoraGroups.rebuild(next.result.pitch);
    next.created=Date.now();return next;
  }
  function protectCurrentManual(candidate,current){
    const next=structuredClone(candidate),moras=next.result.pitch.moras,old=current.result.pitch;
    if(moras.length!==old.moras.length||moras.some((m,i)=>m.text!==old.moras[i].text))throw new Error("候选音拍与当前分析不一致，请重新迁移");
    for(const joined of [...MoraGroups.groups(next.result.pitch)]){
      const conflicts=old.moras.some((m,i)=>i>=joined.start_index&&i<=joined.end_index&&!MoraGroups.group(old,i)&&
        (m.reference_timing_manual||m.reference_timing_discarded||m.recording_match==="manual"||m.recording_match==="discarded"));
      if(conflicts)MoraGroups.split(next.result.pitch,joined.start_index);
    }
    for(const [i,m] of old.moras.entries()){
      if(MoraGroups.group(old,i))continue;
      if(m.reference_timing_manual||m.reference_timing_discarded)for(const field of ["time_start","time_end","reference_timing_manual","reference_timing_discarded","reference_discarded_interval","timing_source","timing_issue"]){
        if(field in m)moras[i][field]=structuredClone(m[field]);else delete moras[i][field];
      }
      if(m.recording_match==="manual"||m.recording_match==="discarded")for(const field of ["recording_start","recording_end","recording_match","recording_discarded_interval","recording_timing_source","recording_timing_issue"]){
        if(field in m)moras[i][field]=structuredClone(m[field]);else delete moras[i][field];
      }
    }
    for(const m of moras)if(!MoraGroups.group(old,moras.indexOf(m))&&m.recording_match==="estimated"&&moras.some(other=>other!==m&&other.recording_match==="manual"&&m.recording_start<other.recording_end&&m.recording_end>other.recording_start))
      Object.assign(m,{recording_start:null,recording_end:null,recording_match:"uncertain",recording_timing_issue:"迁移区间与最新手动确认重叠，请手动设置"});
    for(const m of moras)if(!MoraGroups.group(old,moras.indexOf(m))&&!m.reference_timing_manual&&!m.reference_timing_discarded&&Number.isFinite(m.time_start)&&moras.some(other=>other!==m&&other.reference_timing_manual&&m.time_start<other.time_end&&m.time_end>other.time_start))
      Object.assign(m,{time_start:null,time_end:null,reference_timing_discarded:true,timing_issue:"自动区间与最新标准音校准重叠，请手动设置"});
    next.result.pitch.manual_history=structuredClone(old.manual_history||[]);
    next.result.pitch.manual_revision=old.manual_revision||0;
    next.result.pitch.calibration_edits=structuredClone(old.calibration_edits||{});
    next.result.pitch.pause_intervals={...structuredClone(next.result.pitch.pause_intervals||{}),...structuredClone(old.pause_intervals||{})};
    // Grouping and its explicit outer boundaries are edits, not inferred child timings.
    for(const saved of MoraGroups.groups(old)){
      let joined=MoraGroups.groups(next.result.pitch).find(g=>g.start_index===saved.start_index&&g.end_index===saved.end_index);
      if(!joined){
        next.result.pitch.mora_groups=MoraGroups.groups(next.result.pitch).filter(g=>g.end_index<saved.start_index||g.start_index>saved.end_index);
        joined=structuredClone(saved);next.result.pitch.mora_groups.push(joined);next.result.pitch.mora_groups.sort((a,b)=>a.start_index-b.start_index);
      }
      for(const track of ["reference","recording"])if(saved[track]?.manual||saved[track]?.discarded)joined[track]=structuredClone(saved[track]);
      joined.hidden_pauses=structuredClone(saved.hidden_pauses||{});
    }
    MoraGroups.rebuild(next.result.pitch);
    return next;
  }
  function transferPauses(data,analysis,template,track){
    const pauses={source:template.value.pauses||[],target:analysis.result.pitch.pause_intervals?.[track]||[]};
    if(pauses.source.length||pauses.target.length)data.append("pauses",JSON.stringify(pauses));
    return pauses.source.length||pauses.target.length;
  }
  async function transfer(take,analysis,template){
    const data=new FormData();
    data.append("sample",template.blob,"sample.wav");data.append("audio",await readAudio(take,analysis,"recording"),"recording.wav");
    data.append("moras",JSON.stringify(MoraGroups.transferValues(template.value)));
    const hasPauses=transferPauses(data,analysis,template,"recording");
    const response=await fetch("/api/audio/mora-transfer",{method:"POST",body:data});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"校准样本迁移失败");
    if(hasPauses&&result.pause_handling!=="separate")throw new Error("停顿匹配服务尚未更新，请退出并重新打开日语跟读 App，再复用校准");
    return buildCandidate(analysis,template,result);
  }
  async function realignRecording(take,analysis){
    const groups=MoraGroups.calibrationGroups(analysis.result.pitch,"reference");
    const source={moras:values(analysis,"reference"),groups,created:analysis.created};
    const moras=MoraGroups.transferValues(source).map((m,index)=>({...m,confirmed:!m.discarded&&Number.isFinite(m.start)&&Number.isFinite(m.end)&&m.end>m.start&&
      (m.confirmed||!MoraGroups.group(analysis.result.pitch,index)&&analysis.result.pitch.moras[index].timing_source==="variant-calibration-transfer")}));
    const eligible=moras.filter(m=>{const info=MoraGroups.info(analysis.result.pitch,m.index,"recording");return m.confirmed&&!info.manual&&!info.discarded&&info.source!=="calibrated-recording-transfer";});
    if(!eligible.length)return {analysis,count:0,pending:0};
    const sample=await readAudio(take,analysis,"reference"),audio=await readAudio(take,analysis,"recording");
    const data=new FormData();data.append("sample",sample,"standard.wav");data.append("audio",audio,"recording.wav");
    data.append("moras",JSON.stringify(moras));
    data.append("pauses",JSON.stringify({source:analysis.result.pitch.pause_intervals?.reference||[],target:analysis.result.pitch.pause_intervals?.recording||[]}));
    const response=await fetch("/api/audio/mora-transfer",{method:"POST",body:data});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"按标准音校准重新定位录音失败");
    if(result.pause_handling!=="separate"||!Array.isArray(result.intervals))throw new Error("本地音拍匹配服务尚未更新");
    // Match the complete utterance acoustically; old recording boundaries are not crop limits.
    const allowed=new Set(eligible.map(m=>m.index));
    const returned=new Map(result.intervals.filter(item=>allowed.has(item.index)).map(item=>[item.index,item]));
    result.intervals=eligible.map(source=>{
      const item=returned.get(source.index)||{index:source.index,start:null,end:null,issue:"本次校准未返回有效区间，请手动确认"};
      return item.issue&&item.issue!=="根据校准样本迁移，待确认"?{...item,start:null,end:null}:item;
    });
    const next=buildCandidate(analysis,{value:source},result);
    let count=0,pending=0;
    for(const source of eligible){
      const m=next.result.pitch.moras[source.index],joined=MoraGroups.group(next.result.pitch,source.index);
      if(MoraGroups.interval(next.result.pitch,source.index,"recording")&&(joined||m.recording_match==="estimated")){
        if(joined)joined.recording.source="calibrated-reference-to-recording";else m.recording_timing_source="calibrated-reference-to-recording";count++;
      }else pending++;
    }
    next.reference_recording_reuse={count,pending,created:Date.now()};
    delete next.recording_template;
    next.result.pitch.mora_timing_method="calibrated_reference_recording_transfer";
    return {analysis:next,count,pending};
  }
  function buildVariantCandidate(analysis,template,plans,result,automatic=false){
    const next=structuredClone(analysis);delete next.previous;delete next.candidate;
    const reference=template.value.track==="reference",moras=next.result.pitch.moras;
    const pairs=new Map(plans.flatMap(p=>p.pairs).map(p=>[p.source,p]));let count=0;
    for(const item of result.intervals){
      const pair=pairs.get(item.index),index=pair?.target,m=moras[index];if(!m||!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.start<0||item.end<=item.start)continue;
      if(automatic&&item.issue&&item.issue!=="根据校准样本迁移，待确认")continue;
      const track=reference?"reference":"recording";
      if(pair.target_end!==undefined){
        if(!canAdoptGroup(next.result.pitch,index,pair.target_end,track))continue;
        const duration=next.result.audio_data?.[reference?"reference":"recording_raw"]?.duration;
        if(Number.isFinite(duration)&&item.end>duration+.01)continue;
        const joined=MoraGroups.ensure(next.result.pitch,index,pair.target_end);if(!joined||joined[track]?.manual||joined[track]?.discarded)continue;
        joined[track]={start:item.start,end:item.end,manual:false,edited:true,source:reference?"variant-calibration-transfer":"calibrated-recording-transfer",issue:"整组校准迁移，待核对"};count+=pair.target_end-index+1;continue;
      }
      if(MoraGroups.group(next.result.pitch,index))continue;
      if(reference?m.reference_timing_manual||m.reference_timing_discarded:["manual","discarded"].includes(m.recording_match))continue;
      const overlap=moras.some((other,i)=>i!==index&&(reference?other.reference_timing_manual:other.recording_match==="manual")&&item.start<(reference?other.time_end:other.recording_end)&&item.end>(reference?other.time_start:other.recording_start));
      if(overlap)continue;
      if(reference)Object.assign(m,{time_start:item.start,time_end:item.end,reference_timing_manual:false,reference_timing_discarded:false,timing_source:"variant-calibration-transfer",timing_issue:"替换句共同部分迁移，待核对"});
      else Object.assign(m,{recording_start:item.start,recording_end:item.end,recording_match:"estimated",recording_timing_source:"calibrated-recording-transfer",recording_timing_issue:"替换句共同部分迁移，待核对"});
      count++;
    }
    if(!count)throw new Error("共同部分没有可迁移的音拍，或与本次手动修订冲突");
    next.variant_template={track:template.value.track,text:template.value.text,count,audioHash:template.value.audioHash};
    if(MoraGroups.groups(next.result.pitch).length)MoraGroups.rebuild(next.result.pitch);
    next.created=Date.now();return next;
  }
  async function transferVariant(take,analysis,template,selectedPlans=null,automatic=false){
    const plans=selectedPlans||variantPlan(analysis,template);
    if(!plans.length)throw new Error("共同部分缺少可用的定位区间，请先完成本句分析");
    const indices=plans.flatMap(plan=>plan.pairs.map(pair=>pair.source));
    // Separate requests keep repeated source indices unambiguous in the local service response.
    if(new Set(indices).size!==indices.length){
      let next=analysis,count=0;
      for(const plan of plans){next=await transferVariant(take,next,template,[plan],automatic);count+=next.variant_template.count;}
      next.variant_template.count=count;return next;
    }
    const blob=await readAudio(take,analysis,template.value.track);
    if(!blob?.size)throw new Error("本句音频不可用");
    const data=new FormData();data.append("sample",template.blob,"sample.wav");data.append("audio",blob,"target.wav");
    const hasPauses=transferPauses(data,analysis,template,template.value.track);
    data.append("moras",JSON.stringify(MoraGroups.transferValues(template.value)));data.append("segments",JSON.stringify(plans.map(p=>({...p,indices:p.pairs.map(pair=>pair.source),pairs:undefined}))));
    const response=await fetch("/api/audio/mora-transfer",{method:"POST",body:data});const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"替换句校准复用失败");
    if(result.scope!=="segments")throw new Error("本地服务尚未更新，请退出并重新打开日语跟读 App；当前校准未改动");
    if(hasPauses&&result.pause_handling!=="separate")throw new Error("停顿匹配服务尚未更新，请退出并重新打开日语跟读 App，再复用校准");
    return buildVariantCandidate(analysis,template,plans,result,automatic);
  }
  return {readAudio,save,seed,find,reuseReference,applyReference,buildCandidate,protectCurrentManual,transfer,realignRecording,commonRuns,variantPlan,variants,sectionTemplates,buildVariantCandidate,transferVariant,manualPlan,automaticSelections};
})();
