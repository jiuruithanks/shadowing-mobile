"use strict";
(()=>{
  const T=window.TextbookTags,$=id=>document.getElementById(id),el=T.element;
  const lessons=new Map();let catalog=[],loading=true;
  const manage=document.body.dataset.practice==="manage"||new URL(location.href).searchParams.get("view")==="manage";
  $("markedLibrary").hidden=manage;$("tagManagement").hidden=!manage;
  $("marksTitle").textContent=manage?"管理标记":"标记练习";
  document.title=$("marksTitle").textContent+" · 教材跟读";
  $("marksTab").setAttribute("aria-current",manage?"false":"page");
  $("manageTagsTab").setAttribute("aria-current",manage?"page":"false");
  const status=text=>{$("marksStatus").textContent=text;};
  function options(select,entries,label) {
    const value=select.value;
    select.replaceChildren(new Option(label,""),...entries.map(([id,name])=>new Option(name,id)));
    if(entries.some(([id])=>id===value))select.value=value;
  }
  function source(sentence) {
    const lesson=lessons.get(sentence.lessonId),item=lesson?.items.find(i=>i.id===sentence.exerciseId);
    if(!item)return {lesson,item,valid:false};
    let turns=item.turns||[];
    if(item.kind==="自由回答") {
      const answer=(localStorage.getItem("textbook-v1:answer:"+item.id)||"").trim();
      turns=answer?[{role:"我",ja:answer,zh:""}]:[];
    }
    const turn=turns[sentence.index];
    return {lesson,item,valid:turn?.ja===sentence.text&&turn?.role===sentence.role};
  }
  function practiceUrl(sentence,lesson) {
    const url=new URL("textbook.html",location.href);
    url.searchParams.set("lesson",String(lesson.number).padStart(2,"0"));
    url.searchParams.set("turn",String(sentence.index+1));url.hash=sentence.exerciseId;return url.href;
  }
  function renderLibrary(data) {
    const courseList=catalog.map(l=>[l.id,`第 ${l.number} 课 · ${l.title}`]);
    for(const sentence of data.sentences)if(!courseList.some(([id])=>id===sentence.lessonId))
      courseList.push([sentence.lessonId,`第 ${sentence.lessonNumber} 课 · ${sentence.lessonTitle}`]);
    options($("markedCourseFilter"),courseList,"全部课程");
    options($("markedTagFilter"),data.tags.map(t=>[t.id,t.name]),"全部标记");
    const course=$("markedCourseFilter").value,tag=$("markedTagFilter").value,query=$("markedSearch").value.trim().toLocaleLowerCase();
    const rows=data.sentences.filter(s=>(!course||s.lessonId===course)&&(!tag||s.tagIds.includes(tag))&&
      (!query||[s.text,s.translation,s.role,s.exerciseTitle,s.book,s.page,...T.labels(s,data).map(t=>t.name)].join(" ").toLocaleLowerCase().includes(query)));
    $("markedCount").textContent=`${rows.length} 句`;
    const list=$("markedCourses");list.replaceChildren();
    if(!rows.length) {list.append(el("p","empty-state",data.sentences.length?"没有符合条件的句子。":"还没有标记的句子。"));return;}
    for(const [id,name] of courseList) {
      const sentences=rows.filter(s=>s.lessonId===id);if(!sentences.length)continue;
      const lesson=lessons.get(id),order=new Map((lesson?.items||[]).map((item,index)=>[item.id,index]));
      sentences.sort((a,b)=>(order.get(a.exerciseId)??Infinity)-(order.get(b.exerciseId)??Infinity)||
        a.exerciseId.localeCompare(b.exerciseId)||a.index-b.index);
      const section=el("section","marked-course"),heading=el("h2","",name);
      heading.append(el("span","",`${sentences.length} 句`));section.append(heading);
      for(const sentence of sentences) {
        const {lesson,item,valid}=source(sentence),row=el("article","marked-sentence"),copy=el("div","marked-copy");
        const context=el("div","marked-source",`${item?.book||sentence.book} ${item?.page||sentence.page}页 · ${item?.title||sentence.exerciseTitle} · 第 ${sentence.index+1} 句 · ${sentence.role}`);
        const ja=el(valid?"a":"p","marked-ja",sentence.text);ja.lang="ja";
        if(valid){ja.href=practiceUrl(sentence,lesson);ja.title="回到原句练习";}
        const translation=el("p","marked-zh",sentence.translation),tags=el("div","turn-tags");T.chips(tags,T.labels(sentence,data));
        copy.append(context,ja,translation,tags);
        if(!valid)copy.append(el("div","marked-missing",loading?"正在读取课程…":!lesson?"课程暂时无法读取":!item?"原练习已移除":"原句已修改"));
        const actions=el("div","marked-actions");
        if(valid) {
          const practice=el("a","text-button"),icon=el("i");icon.dataset.lucide="arrow-up-right";
          practice.href=practiceUrl(sentence,lesson);practice.append(icon,document.createTextNode("练习"));actions.append(practice);
        }
        const edit=T.iconButton("tags","修改这句的标记");edit.onclick=()=>{try{T.openPicker(sentence);}catch(e){status(e.message);}};
        const remove=T.iconButton("bookmark-minus","移除此句的全部标记");remove.onclick=()=>{
          if(!confirm("移除这句的全部标记？不会删除句子、配音或录音。"))return;
          try{T.assign(sentence,[]);status("");}catch(e){status(e.message);}
        };
        actions.append(edit,remove);row.append(copy,actions);section.append(row);
      }
      list.append(section);
    }
  }
  function renderManagement(data) {
    const list=$("managedTags");list.replaceChildren();
    if(!data.tags.length)list.append(el("p","empty-state","暂无标记"));
    for(const tag of data.tags) {
      const row=el("div","manage-tag-row"),name=el("span","tag-name",tag.name);
      const count=data.sentences.filter(s=>s.tagIds.includes(tag.id)).length;
      const usage=el("span","tag-usage",`${count} 句`),rename=T.iconButton("pencil","重命名“"+tag.name+"”"),remove=T.iconButton("trash-2","删除“"+tag.name+"”");
      remove.classList.add("delete-tag");
      rename.onclick=()=>{
        const form=el("form","tag-edit-form"),input=el("input");input.value=tag.name;input.maxLength=40;input.required=true;input.setAttribute("aria-label","标记名称");
        const save=T.iconButton("check","保存名称"),cancel=T.iconButton("x","取消改名");save.type="submit";
        cancel.onclick=()=>render();form.append(input,save,cancel);name.replaceWith(form);rename.hidden=true;
        input.onkeydown=event=>{if(event.key==="Escape"){event.preventDefault();render();}};
        form.onsubmit=event=>{event.preventDefault();try{T.rename(tag.id,input.value);status("");}catch(e){status(e.message);}};
        input.focus();input.select();window.lucide?.createIcons();
      };
      remove.onclick=()=>{
        if(!confirm(`删除标记“${tag.name}”？${count?`将从 ${count} 个句子中移除此标记。`:""}不会删除配音或录音。`))return;
        try{T.remove(tag.id);status("");}catch(e){status(e.message);}
      };
      row.append(name,usage,rename,remove);list.append(row);
    }
  }
  function render() {
    try {
      const data=T.read();$("markedTotal").textContent=`已标记 ${data.sentences.length} 句`;
      if(manage)renderManagement(data);else renderLibrary(data);
      window.lucide?.createIcons();
    }catch(e){status(e.message);}
  }
  $("createTagForm").onsubmit=event=>{
    event.preventDefault();try{T.create($("newTagName").value);$("newTagName").value="";status("");$("newTagName").focus();}catch(e){status(e.message);}
  };
  $("markedCourseFilter").onchange=render;$("markedTagFilter").onchange=render;$("markedSearch").oninput=render;
  T.subscribe(render);
  window.addEventListener("storage",event=>{if(event.key?.startsWith("textbook-v1:answer:"))render();});
  window.addEventListener("pageshow",render);
  async function init() {
    render();
    try {
      const getCourse=window.TextbookOffline?TextbookOffline.fetch:fetch;
      const response=await getCourse("textbook-lessons.json?v=lessons-1-10-1");if(!response.ok)throw new Error("课程目录加载失败，请刷新重试。");
      catalog=(await response.json()).lessons;
      const last=Number(localStorage.getItem("textbook-v1:lastLesson")||1),entry=catalog.find(l=>l.number===last)||catalog[0];
      if(!entry)return;
      const back=new URL(window.TextbookOffline?"mobile-textbook.html":"textbook.html",location.href);back.searchParams.set("lesson",String(entry.number).padStart(2,"0"));
      back.hash=localStorage.getItem("textbook-v1:lastItem:"+entry.id)||entry.defaultItem;$("courseReturn").href=back.href;
      if(!manage) {
        const results=await Promise.allSettled(catalog.map(async entry=>{
          const response=await getCourse(entry.file+"?v=lessons-1-10-1");if(!response.ok)throw new Error();
          const lesson=await response.json();if(lesson.id!==entry.id||!Array.isArray(lesson.items))throw new Error();lessons.set(entry.id,lesson);
        }));
        if(results.some(r=>r.status==="rejected"))status("部分课程未能读取，标记仍保留，请刷新重试。");
      }
    }catch(e){status(e.message||"课程读取失败，请刷新重试。");}
    loading=false;render();
  }
  init();
})();
