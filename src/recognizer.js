import {clamp,dist,resample,pathLength,bounds,smooth} from "./engine.js";

const TEMPLATE_KEY="witch-hat-lab:recognizer-templates:v3";
const LEGACY_TEMPLATE_KEYS=["witch-hat-lab:recognizer-templates:v2","witch-hat-lab:recognizer-templates:v1"];
const MAX_SAMPLES=16;
const RESAMPLE_POINTS=64;
const ROTATION_TOLERANCE_DEG=12;
const ROTATION_STEPS=7;
const OUTLIER_DISTANCE=.48;

const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
function prepareStroke(points){
  const clean=(points||[]).filter(finitePoint);
  if(clean.length<2)return clean;
  const dedup=[clean[0]];
  for(let i=1;i<clean.length;i++)if(dist(clean[i],dedup[dedup.length-1])>.5)dedup.push(clean[i]);
  return resample(smooth(dedup,1),RESAMPLE_POINTS);
}

function normaliseGlyph(strokes){
  const prepared=(strokes||[]).map(prepareStroke).filter(s=>s.length>=4);
  if(!prepared.length)return [];
  const b=bounds(prepared.flat()),size=Math.max(b.w,b.h,1);
  return prepared.map(stroke=>stroke.map(p=>({x:(p.x-b.cx)/size,y:(p.y-b.cy)/size})));
}

function rotateGlyph(strokes,angle){
  const c=Math.cos(angle),s=Math.sin(angle);
  return strokes.map(stroke=>stroke.map(p=>({x:p.x*c-p.y*s,y:p.x*s+p.y*c})));
}

function cleanSample(strokes){return normaliseGlyph(strokes||[])}
function cleanTemplate(template){
  const rawSamples=Array.isArray(template?.samples)?template.samples:(template?.strokes?.length?[template.strokes]:[]);
  return {
    id:template.id,
    name:template.name,
    kind:template.kind,
    status:template.status||"reference",
    source:template.source||"",
    samples:rawSamples.map(cleanSample).filter(s=>s.length).slice(0,MAX_SAMPLES),
    trainedAt:template.trainedAt||"",
    lastSampleDistance:Number.isFinite(template.lastSampleDistance)?template.lastSampleDistance:null,
    outlierWarning:template.outlierWarning||""
  };
}

function readStored(key){
  try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null}catch{return null}
}
function migrateLegacy(){
  for(const key of LEGACY_TEMPLATE_KEYS){
    const parsed=readStored(key);
    if(parsed)return Object.fromEntries(Object.entries(parsed).map(([id,t])=>[id,cleanTemplate(t)]));
  }
  return {};
}
export function loadTemplates(){
  try{
    const parsed=readStored(TEMPLATE_KEY)||migrateLegacy();
    return Object.fromEntries(Object.entries(parsed||{}).map(([id,t])=>[id,cleanTemplate(t)]));
  }catch{return {}}
}

function strokePointDistance(a,b){
  const n=RESAMPLE_POINTS,pa=resample(a,n),pb=resample(b,n);
  let sum=0;
  for(let i=0;i<n;i++)sum+=dist(pa[i],pb[i]);
  return sum/n;
}
function dtwDistance(a,b){
  const pa=resample(a,RESAMPLE_POINTS),pb=resample(b,RESAMPLE_POINTS),n=pa.length,m=pb.length;
  let row=new Float64Array(m+1);row.fill(Infinity);row[0]=0;
  for(let i=1;i<=n;i++){
    const next=new Float64Array(m+1);next.fill(Infinity);
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
  const n=Math.min(a.length,b.length);if(!n)return 1;
  let sum=0;
  for(let i=0;i<n;i++){
    const d=Math.atan2(Math.sin(a[i]-b[i]),Math.cos(a[i]-b[i]));
    sum+=Math.abs(d)/Math.PI;
  }
  return sum/n;
}
function bboxDistance(a,b){
  const aa=bounds(a),bb=bounds(b),size=Math.max(aa.w,aa.h,bb.w,bb.h,1);
  return clamp((Math.abs(aa.w-bb.w)+Math.abs(aa.h-bb.h))/size/2);
}
function centroidDistance(a,b){return clamp(Math.hypot(a.x-b.x,a.y-b.y)/.9)}
function strokeStats(points){
  const b=bounds(points),len=pathLength(points)||1;
  return {
    cx:b.cx,cy:b.cy,w:b.w,h:b.h,
    length:len,
    aspect:b.w/(b.h||1),
    closure:dist(points[0],points.at(-1))/(Math.hypot(b.w,b.h)||1)
  };
}
function strokeCost(input,template){
  const a=strokeStats(input),b=strokeStats(template);
  const direct=strokePointDistance(input,template);
  const dtw=dtwDistance(input,template);
  const angle=angleDistance(directionSignature(input),directionSignature(template));
  const box=bboxDistance(input,template);
  const centroid=centroidDistance({x:a.cx,y:a.cy},{x:b.cx,y:b.cy});
  const lengthRatio=Math.abs(Math.log((a.length+1e-5)/(b.length+1e-5)));
  const aspect=clamp(Math.abs(Math.log((a.aspect+.05)/(b.aspect+.05)))/2);
  const closure=clamp(Math.abs(a.closure-b.closure)/.35);
  return .27*clamp(direct/.22)+
    .27*clamp(dtw/.22)+
    .13*angle+
    .10*box+
    .10*centroid+
    .07*clamp(lengthRatio)+
    .04*aspect+
    .02*closure;
}

// Exact assignment for normal-sized glyphs. This removes the old greedy
// matching failure where an early locally-good stroke could steal the stroke
// needed by a better global pairing.
function optimalAssignment(input,template){
  const n=input.length,m=template.length;
  if(!n||!m)return {cost:1,matched:0};
  if(n>10||m>10){
    const unused=new Set(template.map((_,i)=>i));let total=0,matched=0;
    for(const stroke of input){
      let best=-1,bestCost=Infinity;
      for(const j of unused){const c=strokeCost(stroke,template[j]);if(c<bestCost){bestCost=c;best=j}}
      if(best>=0){unused.delete(best);total+=bestCost;matched++}else total+=.85;
    }
    return {cost:total/Math.max(n,m),matched};
  }
  const memo=new Map();
  const solve=(i,mask)=>{
    const key=i+"|"+mask;if(memo.has(key))return memo.get(key);
    if(i===n){
      const remaining=m-mask.toString(2).replace(/0/g,"").length;
      const value={cost:remaining*.72,matched:0};memo.set(key,value);return value;
    }
    let best={cost:Infinity,matched:0};
    for(let j=0;j<m;j++)if(!(mask&(1<<j))){
      const next=solve(i+1,mask|(1<<j));
      const candidate={cost:strokeCost(input[i],template[j])+next.cost,matched:1+next.matched};
      if(candidate.cost<best.cost)best=candidate;
    }
    const skip={cost:.72+solve(i+1,mask).cost,matched:solve(i+1,mask).matched};
    if(skip.cost<best.cost)best=skip;
    memo.set(key,best);return best;
  };
  const result=solve(0,0);
  return {cost:result.cost/Math.max(n,m),matched:result.matched};
}

function centroidLayoutDistance(a,b){
  if(!a.length||!b.length)return 1;
  const aa=a.map(strokeStats).sort((x,y)=>x.cy-y.cy||x.cx-y.cx);
  const bb=b.map(strokeStats).sort((x,y)=>x.cy-y.cy||x.cx-y.cx);
  const n=Math.min(aa.length,bb.length);
  let sum=Math.abs(aa.length-bb.length)*.35;
  for(let i=0;i<n;i++)sum+=Math.hypot(aa[i].cx-bb[i].cx,aa[i].cy-bb[i].cy);
  return clamp(sum/Math.max(1,Math.max(aa.length,bb.length)*.75));
}

function matchAtRotation(input,template,angle){
  const rotated=angle?rotateGlyph(input,angle):input;
  const assignment=optimalAssignment(rotated,template);
  const countPenalty=Math.abs(rotated.length-template.length)*.24;
  const layout=centroidLayoutDistance(rotated,template);
  return clamp(assignment.cost+countPenalty+.08*layout);
}

function compareSample(input,template){
  let best={distance:1,rotation:0,matched:0};
  const max=ROTATION_TOLERANCE_DEG*Math.PI/180;
  for(let i=0;i<ROTATION_STEPS;i++){
    const t=ROTATION_STEPS===1?.5:i/(ROTATION_STEPS-1);
    const angle=-max+(2*max*t);
    const distance=matchAtRotation(input,template,angle);
    if(distance<best.distance)best={distance,rotation:angle*180/Math.PI,matched:optimalAssignment(rotateGlyph(input,angle),template).matched};
  }
  return best;
}

export function compareToTemplate(strokes,template){
  const input=normaliseGlyph(strokes||[]),t=cleanTemplate(template);
  if(!input.length||!t.samples.length)return {distance:1,confidence:0,sampleIndex:-1,rotation:0,matched:0};
  const results=t.samples.map((sample,index)=>{
    const result=compareSample(input,sample);
    return {
      ...result,
      confidence:clamp(1-result.distance/.78),
      sampleIndex:index,
      strokeCountMatch:input.length===sample.length
    };
  }).sort((a,b)=>a.distance-b.distance);
  const best=results[0];
  return {...best,nearby:results.slice(0,3)};
}

function sampleOutlierDistance(sample,existing){
  if(!existing.length)return null;
  return Math.min(...existing.map(x=>compareSample(sample,x).distance));
}

export function saveTemplate(glyph,strokes){
  const cleaned=normaliseGlyph(strokes||[]);
  if(!cleaned.length)throw new Error("A template needs at least one usable stroke.");
  if(pathLength(cleaned.flat())<24)throw new Error("The template drawing is too short.");
  const templates=loadTemplates();
  const current=templates[glyph.id]||cleanTemplate(glyph);
  const existing=current.samples||[];
  const nearest=sampleOutlierDistance(cleaned,existing);
  const outlierWarning=nearest!=null&&nearest>OUTLIER_DISTANCE
    ?"This sample is an outlier compared with your existing "+glyph.name+" samples. Keep it only if the drawing is intentionally different."
    :"";
  current.samples=[...existing,cleaned].slice(-MAX_SAMPLES);
  current.trainedAt=new Date().toISOString();
  current.lastSampleDistance=nearest;
  current.outlierWarning=outlierWarning;
  templates[glyph.id]=cleanTemplate(current);
  localStorage.setItem(TEMPLATE_KEY,JSON.stringify(templates));
  return templates[glyph.id];
}

export function removeTemplate(id){
  const templates=loadTemplates();delete templates[id];
  localStorage.setItem(TEMPLATE_KEY,JSON.stringify(templates));
}
export function clearTemplates(){
  localStorage.removeItem(TEMPLATE_KEY);
  LEGACY_TEMPLATE_KEYS.forEach(k=>localStorage.removeItem(k));
}
export function templateState(glyphs){
  const saved=loadTemplates();
  return glyphs.map(g=>({...g,trained:Boolean(saved[g.id]),template:saved[g.id]||null}));
}

export function recogniserHealth(glyph,template){
  const t=cleanTemplate(template);
  if(!t.samples.length)return {samples:0,spread:null,outlier:false};
  const nearest=t.samples.map((sample,i)=>{
    const others=t.samples.filter((_,j)=>j!==i);
    return others.length?{i,distance:sampleOutlierDistance(sample,others)}:{i,distance:null};
  });
  const distances=nearest.map(x=>x.distance).filter(Number.isFinite);
  const spread=distances.length?distances.reduce((a,b)=>a+b,0)/distances.length:null;
  return {
    samples:t.samples.length,
    spread,
    outlier:nearest.some(x=>x.distance!=null&&x.distance>OUTLIER_DISTANCE)
  };
}

export function recogniseGlyph(strokes,glyphs,kind="sigil"){
  const usable=normaliseGlyph(strokes||[]);
  if(!usable.length)return {status:"missing",label:"No glyph detected",confidence:0,candidates:[],reason:"No usable strokes."};
  const templates=loadTemplates();
  const available=glyphs.filter(g=>g.kind===kind&&templates[g.id]?.samples?.length);
  if(!available.length)return {status:"untrained",label:"Recognizer not calibrated",confidence:0,candidates:[],reason:"No "+kind+" templates have been calibrated yet."};
  const candidates=available.map(g=>({...g,...compareToTemplate(usable,templates[g.id]),health:recogniserHealth(g,templates[g.id])})).sort((a,b)=>a.distance-b.distance);
  const top=candidates[0],second=candidates[1];
  const margin=second?second.distance-top.distance:top.distance;
  const confidence=clamp(1-top.distance/.78);
  // Confidence is based on absolute geometric fit; margin protects against
  // visually similar sigils. A lone class can be accepted with good fit.
  const recognised=top.distance<=.36&&(!second||margin>=.055);
  return {
    status:recognised?"recognised":"ambiguous",
    label:recognised?top.name:"Ambiguous glyph",
    confidence,
    distance:top.distance,
    candidates:candidates.slice(0,5),
    margin,
    reason:recognised
      ?"Best match has a strong geometric fit and sufficient separation."
      :"The geometric fit or separation from the nearest alternative is not strong enough.",
    rotation:top.rotation
  };
}

export function extractCentralGlyphStrokes(strokes,primaryRingIndex=-1){
  const candidates=(strokes||[]).map((p,index)=>({index,p,b:bounds(p)})).filter(x=>x.index!==primaryRingIndex&&x.p.length>=4);
  if(!candidates.length)return [];
  const centre=primaryRingIndex>=0?bounds(strokes[primaryRingIndex]):bounds(candidates.flatMap(x=>x.p));
  const ringSize=primaryRingIndex>=0?Math.max(centre.w,centre.h):Math.max(centre.w,centre.h,1);
  // Central sigils are selected by containment within the inner region of the
  // ring, not by an arbitrary nearest-stroke choice. Keep multiple strokes:
  // a sigil may legitimately be multistroke.
  const radius=ringSize*(primaryRingIndex>=0?.36:.30);
  const near=candidates.filter(x=>Math.hypot(x.b.cx-centre.cx,x.b.cy-centre.cy)<=radius);
  const chosen=near.length?near:[candidates.slice().sort((a,b)=>Math.hypot(a.b.cx-centre.cx,a.b.cy-centre.cy)-Math.hypot(b.b.cx-centre.cx,b.b.cy-centre.cy))[0]];
  return chosen.map(x=>x.p);
}
