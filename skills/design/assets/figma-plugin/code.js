// >>> SPEC 由 build-inline.js 自动替换，手改不会生效于生成产物
const SPEC = {"name":"示例","page":"example","state":"正常态","frame":{"width":375,"height":812,"background":"#FFFFFF"},"nodes":[{"type":"text","name":"title","x":16,"y":60,"text":"示例","font":{"family":"Inter","style":"Regular","size":17},"fill":"#1A1A1A"}],"annotations":[]};
// <<< SPEC

function hexToRgb(hex){const h=hex.replace('#','');return {r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255};}
function solid(hex){return [{type:'SOLID',color:hexToRgb(hex)}];}

async function buildNode(spec, parent){
  if(spec.type==='frame'){
    const f=figma.createFrame();
    f.name=spec.name||'frame';
    if(spec.width&&spec.height) f.resize(spec.width,spec.height);
    if(spec.fill) f.fills=solid(spec.fill);
    if(spec.radius) f.cornerRadius=spec.radius;
    if(spec.layout){
      f.layoutMode=spec.layout.mode;
      const p=spec.layout.padding||[0,0,0,0];
      f.paddingTop=p[0]; f.paddingRight=p[1]; f.paddingBottom=p.length>2?p[2]:p[0]; f.paddingLeft=p.length>3?p[3]:p[1];
      f.itemSpacing=spec.layout.spacing||0;
      f.counterAxisAlignItems=spec.layout.align||'MIN';
    }
    parent.appendChild(f);
    if(!spec.layout){ f.x=spec.x||0; f.y=spec.y||0; }
    for(const c of (spec.children||[])) await buildNode(c,f);
    return f;
  }
  if(spec.type==='rect'){
    const r=figma.createRectangle();
    r.name=spec.name||'rect';
    r.resize(spec.width,spec.height);
    if(spec.fill) r.fills=solid(spec.fill);
    if(spec.radius) r.cornerRadius=spec.radius;
    parent.appendChild(r);
    if(!parent.layoutMode){ r.x=spec.x||0; r.y=spec.y||0; }
    return r;
  }
  if(spec.type==='text'){
    await figma.loadFontAsync({family:spec.font.family,style:spec.font.style});
    const t=figma.createText();
    t.name=spec.name||'text';
    t.fontName={family:spec.font.family,style:spec.font.style};
    t.characters=spec.text;
    t.fontSize=spec.font.size;
    t.fills=solid(spec.fill||'#000000');
    t.textAutoResize='HEIGHT';
    parent.appendChild(t);
    if(!parent.layoutMode){ t.x=spec.x||0; t.y=spec.y||0; }
    return t;
  }
  if(spec.type==='instance'){
    // 本地插件无法凭空造组件实例（需要组件 key），先建占位 frame 并标红名，等设计师在 Figma 里替换
    const f=figma.createFrame();
    f.name='⚠️ 待替换为组件：'+(spec.component||'未指定');
    f.resize(spec.width||100, spec.height||40);
    f.fills=[];
    f.strokes=solid('#FF3B30');
    f.strokeWeight=1;
    f.dashPattern=[4,4];
    parent.appendChild(f);
    if(!parent.layoutMode){ f.x=spec.x||0; f.y=spec.y||0; }
    return f;
  }
  if(spec.type==='image'){
    // 插件无法凭空新增图片资产，先建占位框，图片需人工放置或走 upload_assets
    const f=figma.createFrame();
    f.name='⚠️ 待替换为图片：'+(spec.name||'image');
    f.resize(spec.width||100, spec.height||100);
    f.fills=solid(spec.fill||'#E5E5EA');
    if(spec.radius) f.cornerRadius=spec.radius;
    parent.appendChild(f);
    if(!parent.layoutMode){ f.x=spec.x||0; f.y=spec.y||0; }
    return f;
  }
  throw new Error('未登记的节点类型: '+spec.type);
}

(async()=>{
  try{
    const root=figma.createFrame();
    root.name=`${SPEC.page}/${SPEC.state}`;
    root.resize(SPEC.frame.width,SPEC.frame.height);
    root.fills=solid(SPEC.frame.background);
    figma.currentPage.appendChild(root);
    const built={};
    for(const n of SPEC.nodes){ const node=await buildNode(n,root); built[n.name]=node; }
    for(const a of SPEC.annotations){
      const target=built[a.node];
      if(!target) continue;
      try{ target.annotations=[{label:a.text}]; }
      catch(e){ const t=figma.createText(); t.characters=a.text; root.appendChild(t); }
    }
    figma.currentPage.selection=[root];
    figma.viewport.scrollAndZoomIntoView([root]);
    figma.closePlugin(`已导入 ${SPEC.nodes.length} 个节点`);
  }catch(e){ figma.closePlugin('导入失败：'+e.message); }
})();
