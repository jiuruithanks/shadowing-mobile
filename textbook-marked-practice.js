"use strict";

window.MarkedPractice=(()=>{
  let rows=[],selected="",ready=false,course="",tag="",query="",revision=0;
  const el=(name,className,text)=>TextbookTags.element(name,className,text);
  function collect() {
    const data=TextbookTags.read(),result=[];
    for(const lesson of state.lessons)for(const item of lesson.items) {
      const turns=availableTurns(item);
      for(const sentence of data.sentences.filter(s=>s.lessonId===lesson.id&&s.exerciseId===item.id)) {
        const turn=turns[sentence.index];
        if(course&&lesson.id!==course||tag&&!sentence.tagIds.includes(tag))continue;
        const labels=TextbookTags.labels(sentence,data);
        if(query&&![sentence.text,sentence.translation,sentence.role,item.title,...labels.map(t=>t.name)].join(" ").toLowerCase().includes(query))continue;
        result.push({sentence,lesson,item,labels,valid:turn?.ja===sentence.text&&turn?.role===sentence.role});
      }
    }
    return result;
  }
  function renderNav() {
    if(!ready)return;
    const nav=$("exerciseNav");nav.replaceChildren();
    $("itemCount").textContent=rows.length+" 个标记句子";$("doneCount").textContent="";
    let lessonId="";
    for(const row of rows) {
      if(row.lesson.id!==lessonId) {
        const heading=el("div","nav-book",`第 ${row.lesson.number} 课 · ${row.lesson.title}`);nav.append(heading);lessonId=row.lesson.id;
      }
      const button=el("button","exercise-link marked-link"+(selected===row.sentence.key?" active":""));
      button.type="button";button.dataset.sentence=row.sentence.key;
      button.setAttribute("aria-current",String(selected===row.sentence.key));
      const label=el("span","exercise-label"),text=el("span","",row.sentence.text);text.lang="ja";
      label.append(text,el("small","",`${row.item.book} ${row.item.page}页 · ${row.sentence.role}`));
      const tags=el("span","turn-tags");TextbookTags.chips(tags,row.labels);label.append(tags);
      const recorded=[...(state.recordingIndex.get(row.item.id)?.values()||[])].some(t=>t.hasAudio&&
        t.sentence?.lessonId===row.lesson.id&&t.sentence.index===row.sentence.index&&
        t.sentence.text===row.sentence.text&&t.sentence.role===row.sentence.role);
      if(recorded)label.append(el("small","marked-recorded","已录音"));
      if(!row.valid)label.append(el("small","marked-stale","原句已修改"));
      button.append(label);button.onclick=()=>choose(row);nav.append(button);
    }
    if(!rows.length)nav.append(el("p","empty-state","没有符合条件的标记句子。"));
  }
  function updateControls() {
    if(!ready)return;
    const usable=rows.filter(r=>r.valid),index=usable.findIndex(r=>r.sentence.key===selected);
    $("previous").disabled=index<=0;$("next").disabled=index<0||index>=usable.length-1;
    if(state.item) {
      $("turnCount").textContent="第 "+(state.turn+1)+" 句";
      $("currentLabel").textContent=(index>=0?`${index+1} / ${usable.length} · `:"")+(itemTurns()[state.turn]?.role||"");
    }
  }
  function clear(message="请选择左侧的标记句子。") {
    revision++;selected="";stopPreview();cancelPlayback();clearAudio();$("recordedAudio").pause();
    if($("analysisDialog").open)closeSentenceAnalysis();
    state.item=null;state.takes=[];renderTakes();
    document.body.classList.add("marks-empty");$("markedEmpty").textContent=message;
    renderNav();updateControls();
  }
  async function choose(row,play=false) {
    if(isRecording()){notice("请先结束录音并保存，再切换句子。");return;}
    if(!row.valid) {
      clear("这句的原文已修改，旧标记仍保留。可修改或移除旧标记。");
      const button=el("button","text-button","修改旧标记");
      button.onclick=()=>{try{TextbookTags.openPicker(row.sentence);}catch(e){notice(e.message);}};
      $("markedEmpty").append(button);return;
    }
    const generation=++revision;selected=row.sentence.key;save("markedSentence",selected);
    state.lesson=row.lesson;state.navMode="unit";
    document.body.classList.remove("marks-empty");
    await selectItem(row.item.id,row.sentence.index);
    if(generation!==revision)return;
    // Keep the original item and turn index: existing audio, recordings and notes stay shared.
    $("freeAnswer").hidden=true;document.title="标记练习 · 教材跟读";
    updateControls();if(play)await playTurn(state.turn);
  }
  async function refresh() {
    if(!ready||isRecording())return;
    try {
      const data=TextbookTags.read(),filter=$("markedTagFilter");
      if(!data.tags.some(t=>t.id===tag))tag="";
      filter.replaceChildren(new Option("全部标记",""),...data.tags.map(t=>new Option(t.name,t.id)));filter.value=tag;
      rows=collect();renderNav();
      const current=rows.find(r=>r.sentence.key===selected&&r.valid);
      if(!current) {
        const first=rows.find(r=>r.valid);
        if(first)await choose(first);else clear(rows.length?"这些标记的原句已修改，请选择一条查看。":"还没有可练习的标记句子。");
      }else updateControls();
    }catch(e){notice(e.message);}
  }
  function filter() {
    if(isRecording()) {
      $("lessonSelect").value=course;$("markedTagFilter").value=tag;$("search").value=query;
      notice("请先结束录音并保存，再筛选句子。");return;
    }
    course=$("lessonSelect").value;tag=$("markedTagFilter").value;query=$("search").value.trim().toLowerCase();
    save("markedCourse",course);save("markedTag",tag);refresh();
  }
  async function step(delta) {
    if(isRecording()){notice("请先结束录音并保存，再切换句子。");return;}
    const usable=rows.filter(r=>r.valid),index=usable.findIndex(r=>r.sentence.key===selected);
    const row=usable[index+delta];if(row)await choose(row,true);
  }
  async function init() {
    $("lessonHeading").textContent="标记练习";
    $("lessonSelect").replaceChildren(new Option("全部课程",""),...state.catalog.map(l=>new Option(`第 ${l.number} 课 · ${l.title}`,l.id)));
    course=read("markedCourse");if(!state.catalog.some(l=>l.id===course))course="";
    $("lessonSelect").value=course;$("lessonSelect").setAttribute("aria-label","按课程筛选");
    const filterSelect=el("select");filterSelect.id="markedTagFilter";filterSelect.setAttribute("aria-label","按标记筛选");
    $("lessonSelect").after(filterSelect);filterSelect.onchange=filter;
    const manage=el("a","text-button","管理标记");manage.href=(window.TextbookOffline?"mobile-textbook-tags-manage.html":"textbook-tags-manage.html")+"?view=manage";
    manage.onclick=event=>{if(isRecording()){event.preventDefault();notice("请先结束录音并保存。");}};
    $("unitTabs").replaceChildren(manage);
    $("search").placeholder="查找标记句子、角色";$("search").oninput=filter;
    $("recordingsTools").hidden=true;
    const empty=el("div","empty-state");empty.id="markedEmpty";document.querySelector(".practice").prepend(empty);
    document.querySelectorAll(".course-level-nav a").forEach(a=>a.setAttribute("aria-current",a.id==="markedPracticeLink"?"page":"false"));
    tag=read("markedTag");selected=read("markedSentence");ready=true;
    // Re-select once on page load to populate the shared player, even when the saved key exists.
    const last=selected;selected="";rows=collect();
    const row=rows.find(r=>r.valid&&r.sentence.key===last);
    if(row)await choose(row);
    await refresh();
    TextbookTags.subscribe(refresh);
    window.addEventListener("storage",event=>{if(event.key?.startsWith("textbook-v1:answer:"))refresh();});
    window.addEventListener("pageshow",refresh);
  }
  return {init,renderNav,updateControls,filter,step};
})();
