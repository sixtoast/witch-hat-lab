import {clamp,dist,normalise,resample,pathLength,bounds} from "./engine.js";

const TEMPLATE_KEY="witch-hat-lab:recognizer-templates:v1";

function cleanStroke(points){
  return normalise(points||[]).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
}
function cleanTemplate(template){
  return {id:template.id,name:template.name,kind:template.kind,status:template.status||"reference",source:template.source||"",strokes:(template.strokes||[]).map(cleanStroke).filter(s=>s.length>=4)};
}
export function loadTemplates(){
  try{
    const raw=localStorage.getItem(TEMPLATE_KEY); if(!raw)return {};
    const parsed=JSON.parse(raw);
    return Object.fromEntries(Object.entries(parsed).map(([id,t])=>[id,cleanTemplate(t)]));
  }catch{return {}}
}
export function saveTemplate(glyph,strokes){
  const cleaned=(strokes||[]).map(cleanStroke).filter(s=>s.length>=4);
  if(!cleaned.length)throw new Error("A template needs at least one usable stroke.");
  if(pathLength(cleaned.flat())<24)throw new Error("The template drawing is too short.");
  const templates=loadTemplates();
  templates[glyph.id]=cleanTemplate({...glyph,strokes:cleaned,trainedAt:new Date().toISOString()});
  localStorage.setItem(TEMPLATE_KEY,JSON.stringify(templates));
  return templates[glyph.id];
}
export function removeTemplate(id){
  const templates=loadTemplates(); delete templates[id];
  localStorage.setItem(TEMPLATE_KEY,JSON.stringify(templates));
}
export function clearTemplates(){localStorage.removeItem(TEMPLATE_KEY);}
export function templateState(glyphs){
  const saved=loadTemplates();
  return glyphs.map(g=>({...g,trained:Boolean(saved[g.id]),template:saved[g.id]||null}));
}
function strokePointDistance(a,b){
  const n=Math.max(a.length,b.length,32),pa=resample(a,n),pb=resample(b,n);
  let sum=0; for(let i=0;i<n;i++)sum+=dist(pa[i],pb[i]);
  return sum/n;
}
function dtwDistance(a,b){
  const pa=resample(a,64),pb=resample(b,64),n=pa.length,m=pb.length;
  let row=new Float64Array(m+1); row.fill(Infinity); row[0]=0;
  for(let i=1;i<=n;i++){
    const next=new Float64Array(m+1); next.fill(Infinity);
    for(let j=1;j<=m;j++){
      const cost=dist(pa[i-1],pb[j-1]);
      next[j]=cost+Math.min(row[j],next[j-1],row[j-1]);
    }
    row=next;
  }
  return row[m]/(n+m);
}
function directionSignature(points){
  const p=resample(points,48),out=[];
  for(let i=1;i<p.length;i++)out.push(Math.atan2(p[i].y-p[i-1].y,p[i].x-p[i-1].x));
  return out;
}
function angleDistance(a,b){
  const n=Math.min(a.length,b.length); if(!n)return 1;
  let s=0;
  for(let i=0;i<n;i++){
    const d=Math.atan2(Math.sin(a[i]-b[i]),Math.cos(a[i]-b[i])); s+=Math.abs(d)/Math.PI;
  }
  return s/n;
}
function bboxDistance(a,b){
  const aa=bounds(a),bb=bounds(b),size=Math.max(aa.w,aa.h,bb.w,bb.h,1);
  return clamp((Math.abs(aa.w-bb.w)+Math.abs(aa.h-bb.h))/size/2);
}
function strokeCost(input,template){
  const direct=strokePointDistance(input,template);
  const dtw=dtwDistance(input,template);
  const angle=angleDistance(directionSignature(input),directionSignature(template));
  const box=bboxDistance(input,template);
  return .42*clamp(direct/.22)+.34*clamp(dtw/.22)+.16*angle+.08*box;
}
function bestAssignment(input,template){
  if(input.length!==template.length)return {cost:.95,matched:0};
  const unused=new Set(template.map((_,i)=>i)); let cost=0;
  for(const stroke of input){
    let best=-1,bestCost=Infinity;
    for(const j of unused){const c=strokeCost(stroke,template[j]);if(c<bestCost){bestCost=c;best=j}}
    if(best<0)return {cost:1,matched:0};
    unused.delete(best); cost+=bestCost;
  }
  return {cost:cost/input.length,matched:input.length};
}
export function compareToTemplate(strokes,template){
  const input=(strokes||[]).map(cleanStroke).filter(s=>s.length>=4),t=cleanTemplate(template);
  if(!input.length||!t.strokes.length)return {distance:1,confidence:0};
  const assignment=bestAssignment(input,t.strokes);
  const countPenalty=Math.abs(input.length-t.strokes.length)*.24;
  const distance=clamp(assignment.cost+countPenalty);
  return {distance,confidence:clamp(1-distance/.72),strokeCountMatch:input.length===t.strokes.length,matched:assignment.matched};
}
export function recogniseGlyph(strokes,glyphs,kind="sigil"){
  const usable=(strokes||[]).map(cleanStroke).filter(s=>s.length>=4);
  if(!usable.length)return {status:"missing",label:"No glyph detected",confidence:0,candidates:[],reason:"No usable strokes."};
  const templates=loadTemplates();
  const available=glyphs.filter(g=>g.kind===kind&&templates[g.id]?.strokes?.length);
  if(!available.length)return {status:"untrained",label:"Recognizer not calibrated",confidence:0,candidates:[],reason:"No "+kind+" templates have been calibrated yet."};
  const candidates=available.map(g=>({...g,...compareToTemplate(usable,templates[g.id])})).sort((a,b)=>b.confidence-a.confidence);
  const top=candidates[0],second=candidates[1],margin=second?top.confidence-second.confidence:top.confidence;
  const recognised=top.confidence>=.72&&margin>=.10;
  return {status:recognised?"recognised":"ambiguous",label:recognised?top.name:"Ambiguous glyph",confidence:top.confidence,candidates:candidates.slice(0,5),margin,reason:recognised?"Best match clears the confidence and ambiguity thresholds.":"No candidate clears both the confidence and ambiguity thresholds."};
}


export function extractCentralGlyphStrokes(strokes,primaryRingIndex=-1){
  const candidates=(strokes||[]).map((p,index)=>({index,p,b:bounds(p)})).filter(x=>x.index!==primaryRingIndex&&x.p.length>=4);
  if(!candidates.length)return [];
  const centre=primaryRingIndex>=0?bounds(strokes[primaryRingIndex]):bounds(candidates.flatMap(x=>x.p));
  const radius=Math.max(centre.w,centre.h,1)*.34;
  const near=candidates.filter(x=>Math.hypot(x.b.cx-centre.cx,x.b.cy-centre.cy)<=radius);
  const chosen=near.length?near:[candidates.slice().sort((a,b)=>Math.hypot(a.b.cx-centre.cx,a.b.cy-centre.cy)-Math.hypot(b.b.cx-centre.cx,b.b.cy-centre.cy))[0]];
  return chosen.map(x=>x.p);
}
