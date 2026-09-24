"use strict";

window.TextbookTags=(()=>{
  const key="textbook-v1:sentenceTags:v1";
  const changed="textbook-tags-changed";
  const empty=()=>({version:1,tags:[],sentences:[]});
  function read() {
    let raw;
    try {raw=localStorage.getItem(key);} catch {throw new Error("无法读取本机标记，请检查浏览器存储权限。");}
    if(!raw)return empty();
    try {
      const data=JSON.parse(raw);
      if(data.version!==1||!Array.isArray(data.tags)||!Array.isArray(data.sentences)||
        !data.tags.every(t=>typeof t.id==="string"&&typeof t.name==="string")||
        !data.sentences.every(s=>typeof s.key==="string"&&Array.isArray(s.tagIds)&&
          typeof s.lessonId==="string"&&typeof s.exerciseId==="string"&&
          Number.isInteger(s.index)&&typeof s.text==="string"&&typeof s.role==="string"))throw new Error();
      return data;
    } catch {throw new Error("本机标记数据无法读取，原数据未改动。");}
  }
  function update(edit) {
    const data=read(),result=edit(data);
    try {localStorage.setItem(key,JSON.stringify(data));}
    catch {throw new Error("标记未保存：本机空间不足或浏览器禁止存储，请重试。");}
    window.dispatchEvent(new Event(changed));
    return result;
  }
  function nameFor(data,name,except="") {
    const value=name.trim();
    if(!value||value.length>40)throw new Error("标记名称需为 1–40 个字。");
    if(data.tags.some(t=>t.id!==except&&t.name.toLocaleLowerCase()===value.toLocaleLowerCase()))
      throw new Error("已有同名标记。");
    return value;
  }
  function create(name) {
    return update(data=>{
      const tag={id:crypto.randomUUID(),name:nameFor(data,name)};
      data.tags.push(tag);return tag;
    });
  }
  function rename(id,name) {
    update(data=>{
      const tag=data.tags.find(t=>t.id===id);
      if(!tag)throw new Error("这个标记已被删除，请刷新列表。");
      tag.name=nameFor(data,name,id);
    });
  }
  function remove(id) {
    update(data=>{
      data.tags=data.tags.filter(t=>t.id!==id);
      for(const sentence of data.sentences)sentence.tagIds=sentence.tagIds.filter(t=>t!==id);
      data.sentences=data.sentences.filter(s=>s.tagIds.length);
    });
  }
  function sentence(lesson,item,index,turn) {
    // Include source text so an edited answer does not inherit an unrelated sentence's labels.
    return {key:JSON.stringify([lesson.id,item.id,index,turn.role,turn.ja]),
      lessonId:lesson.id,lessonNumber:lesson.number,lessonTitle:lesson.title,
      exerciseId:item.id,exerciseTitle:item.title,book:item.book,page:item.page,number:item.number,
      index,role:turn.role,text:turn.ja,translation:turn.zh||""};
  }
  function assign(sentence,ids,aliases=[]) {
    update(data=>{
      const tagIds=[...new Set(ids)].filter(id=>data.tags.some(t=>t.id===id));
      const keys=new Set([sentence.key,...aliases.map(s=>s.key)]);
      data.sentences=data.sentences.filter(s=>!keys.has(s.key));
      if(tagIds.length)data.sentences.push({...sentence,tagIds,updated:Date.now()});
    });
  }
  function labels(sentence,data=read(),aliases=[]) {
    const keys=new Set([sentence.key,...aliases.map(s=>s.key)]);
    const ids=data.sentences.filter(s=>keys.has(s.key)).flatMap(s=>s.tagIds);
    return data.tags.filter(t=>ids.includes(t.id));
  }
  function subscribe(callback) {
    window.addEventListener(changed,callback);
    window.addEventListener("storage",event=>{if(event.key===key||event.key===null)callback();});
  }
  function element(tag,className,text) {
    const el=document.createElement(tag);if(className)el.className=className;
    if(text!==undefined)el.textContent=text;return el;
  }
  function iconButton(icon,label) {
    const button=element("button","icon-button small");button.type="button";
    button.title=label;button.setAttribute("aria-label",label);
    const i=document.createElement("i");i.dataset.lucide=icon;button.append(i);return button;
  }
  function chips(container,tags) {
    container.replaceChildren(...tags.map(t=>element("span","sentence-tag",t.name)));
  }
  function refreshIcons() {window.lucide?.createIcons();}

  let dialog,pickerSentence,pickerAliases=[],draft=new Set();
  function buildPicker() {
    dialog=element("dialog","tag-picker");dialog.id="sentenceTagDialog";
    dialog.setAttribute("aria-labelledby","sentenceTagTitle");
    const toolbar=element("div","dialog-toolbar"),title=element("strong","","句子标记");title.id="sentenceTagTitle";
    const close=iconButton("x","关闭标记");close.onclick=()=>dialog.close();toolbar.append(title,close);
    const body=element("div","tag-picker-body");
    const sample=element("p","tag-picker-sentence");sample.id="tagSentence";sample.lang="ja";
    const options=element("fieldset","tag-options");options.id="tagOptions";options.setAttribute("aria-label","选择标记");
    const form=element("form","tag-create"),input=element("input");
    input.id="quickTagName";input.placeholder="新标记名称";input.maxLength=40;input.required=true;input.setAttribute("aria-label","新标记名称");
    const add=iconButton("plus","创建标记");add.type="submit";form.append(input,add);
    const status=element("p","tag-status");status.id="tagPickerStatus";status.setAttribute("role","status");
    form.onsubmit=event=>{
      event.preventDefault();
      try {const tag=create(input.value);draft.add(tag.id);input.value="";renderOptions();status.textContent="";}
      catch(e){status.textContent=e.message;}
    };
    body.append(sample,options,form,status);
    const actions=element("div","tag-picker-actions");
    const manage=element("a","","管理标记");manage.href=(window.TextbookOffline?"mobile-textbook-tags-manage.html":"textbook-tags-manage.html")+"?view=manage";
    const apply=element("button","text-button","保存标记");apply.type="button";apply.id="saveSentenceTags";
    apply.onclick=()=>{
      try {assign(pickerSentence,[...draft],pickerAliases);dialog.close();}
      catch(e){status.textContent=e.message;}
    };
    actions.append(manage,apply);dialog.append(toolbar,body,actions);document.body.append(dialog);
  }
  function renderOptions() {
    const options=dialog.querySelector("#tagOptions"),data=read();options.replaceChildren();
    if(!data.tags.length)options.append(element("p","muted","暂无标记"));
    for(const tag of data.tags) {
      const label=element("label","tag-option"),input=element("input");input.type="checkbox";
      input.value=tag.id;input.checked=draft.has(tag.id);
      input.onchange=()=>input.checked?draft.add(tag.id):draft.delete(tag.id);
      label.append(input,element("span","",tag.name));options.append(label);
    }
  }
  function openPicker(sentence,aliases=[]) {
    const data=read();if(!dialog)buildPicker();
    pickerSentence=sentence;pickerAliases=aliases;draft=new Set(labels(sentence,data,aliases).map(t=>t.id));
    dialog.querySelector("#tagSentence").textContent=sentence.text;
    dialog.querySelector("#quickTagName").value="";dialog.querySelector("#tagPickerStatus").textContent="";
    renderOptions();refreshIcons();dialog.showModal();
  }
  subscribe(()=>{
    if(!dialog?.open)return;
    try {renderOptions();}catch(e){dialog.querySelector("#tagPickerStatus").textContent=e.message;}
  });
  return {read,create,rename,remove,sentence,assign,labels,subscribe,element,iconButton,chips,openPicker};
})();
