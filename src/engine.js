// Witch Hat Lab — drawing analysis engine
// This layer intentionally separates measurable pen geometry from semantic spell recognition.

export const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
export const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

export function pathLength(points){
  let n=0; for(let i=1;i<points.length;i++) n+=dist(points[i-1],points[i]); return n;
}

export function bounds(points){
  if(!points.length)return {minX:0,maxX:0,minY:0,maxY:0,w:0,h:0,cx:0,cy:0};
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y)}
  return {minX,maxX,minY,maxY,w:maxX-minX,h:maxY-minY,cx:(minX+maxX)/2,cy:(minY+maxY)/2};
}

export function resample(points,n=128){
  if(points.length<2)return points.slice();
  const total=pathLength(points); if(!total)return points.slice();
  const cumulative=[0]; for(let i=1;i<points.length;i++) cumulative.push(cumulative[i-1]+dist(points[i-1],points[i]));
  const out=[];
  for(let k=0;k<n;k++){
    const target=total*k/(n-1); let i=1;
    while(i<cumulative.length-1&&cumulative[i]<target)i++;
    const span=cumulative[i]-cumulative[i-1]||1, t=(target-cumulative[i-1])/span;
    const a=points[i-1],b=points[i];
    out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
  }
  return out;
}

export function smooth(points,passes=2){
  let p=points.slice();
  for(let k=0;k<passes;k++){
    if(p.length<3)break;
    p=p.map((q,i)=>i===0||i===p.length-1?q:{x:(p[i-1].x+2*q.x+p[i+1].x)/4,y:(p[i-1].y+2*q.y+p[i+1].y)/4});
  }
  return p;
}

export function normalise(points){
  const p=resample(smooth(points));
  const b=bounds(p); const size=Math.max(b.w,b.h,1);
  return p.map(q=>({x:(q.x-b.cx)/size,y:(q.y-b.cy)/size}));
}

export function turningAngles(points){
  const out=[];
  for(let i=1;i<points.length-1;i++){
    const a=Math.atan2(points[i].y-points[i-1].y,points[i].x-points[i-1].x);
    const b=Math.atan2(points[i+1].y-points[i].y,points[i+1].x-points[i].x);
    out.push(Math.atan2(Math.sin(b-a),Math.cos(b-a)));
  }
  return out;
}

export function strokeFeatures(points){
  const b=bounds(points), len=pathLength(points), diag=Math.hypot(b.w,b.h)||1;
  const angles=turningAngles(points);
  const abs=angles.map(Math.abs);
  const turns=abs.filter(x=>x>.65).length;
  const sharp=abs.filter(x=>x>1.35).length;
  const closure=dist(points[0],points[points.length-1])/diag;
  const circularity=clamp(1-Math.abs(b.w-b.h)/(Math.max(b.w,b.h)||1));
  const direct=dist(points[0],points[points.length-1])/(len||1);
  let signed=0; for(const a of angles)signed+=a;
  return {length:len,...b,aspect:b.w/(b.h||1),closure,circularity,directness:direct,turns,sharpTurns:sharp,turningSum:signed};
}

export function ringScore(points){
  if(points.length<8)return 0;
  const f=strokeFeatures(points);
  const closed=clamp(1-f.closure/.22);
  const circle=clamp(f.circularity);
  const smooth=clamp(1-f.sharpTurns/Math.max(12,points.length*.2));
  const coverage=clamp(f.length/(Math.PI*Math.max(f.w,f.h)*.55));
  return clamp(.42*closed+.28*circle+.18*smooth+.12*coverage);
}

export function analyseStroke(points, ring=false){
  const f=strokeFeatures(points);
  if(ring)return {family:"ring",label:"Enclosing ring",confidence:ringScore(points),features:f};
  const p=normalise(points), nf=strokeFeatures(p);
  const radialStart=Math.hypot(p[0]?.x||0,p[0]?.y||0);
  const radialEnd=Math.hypot(p.at(-1)?.x||0,p.at(-1)?.y||0);
  const closed=nf.closure<.30;
  let candidates=[
    ["zigzag",clamp(.35+nf.sharpTurns/Math.max(1,p.length*.08))],
    ["vertical-line",clamp(.3+(nf.h>nf.w*1.8?0.5:0)+(nf.directness>.7?0.2:0))],
    ["horizontal-line",clamp(.3+(nf.w>nf.h*1.8?0.5:0)+(nf.directness>.7?0.2:0))],
    ["loop",clamp(.2+(closed?.45:0)+nf.circularity*.3)],
    ["sweep",clamp(.25+(1-nf.directness)*.35+Math.min(1,nf.turns/12)*.25)],
    ["radial",clamp(.2+Math.abs(radialEnd-radialStart)*.25+(nf.directness>.6?.15:0))]
  ];
  candidates.sort((a,b)=>b[1]-a[1]);
  const top=candidates[0],second=candidates[1];
  return {family:top[0],label:familyLabel(top[0]),confidence:top[1],runnerUp:{family:second[0],confidence:second[1]},ambiguity:Math.max(0,1-(top[1]-second[1])*2),features:f,normalised:p};
}

function familyLabel(f){
  return {zigzag:"Zigzag / Bolt family","vertical-line":"Column / Levitation family","horizontal-line":"Directional line family",loop:"Loop / Diamond family",sweep:"Sweep / Dispersion family",radial:"Radial / convergence family"}[f]||"Unresolved family";
}

export function analyseTopology(strokes){
  const rings=strokes.map(ringScore);
  const ranked=rings.map((score,index)=>({score,index})).sort((a,b)=>b.score-a.score);
  const primary=ranked[0]?.score>.45?ranked[0].index:-1;
  const nested=ranked.filter((x,i)=>x.score>.55&&x.index!==primary&&i<5).map(x=>x.index);
  const marks=strokes.map((p,index)=>({index,...analyseStroke(p,index===primary)})).filter(x=>x.index!==primary);
  const ring=primary>=0?analyseStroke(strokes[primary],true):null;
  const quality=strokes.length?Math.round(strokes.reduce((sum,p)=>sum+strokeQuality(p),0)/strokes.length):0;
  const balance=calculateBalance(marks);
  return {strokes,primaryRing:primary,nestedRings:nested,ringScores:rings,ring,marks,quality,balance,strokeCount:strokes.length};
}

export function strokeQuality(points){
  const f=strokeFeatures(points);
  const closurePenalty=Math.min(1,f.closure*1.6);
  const jitter=Math.min(1,f.sharpTurns/Math.max(10,points.length*.12));
  const continuity=clamp(f.length/Math.max(20,Math.hypot(f.w,f.h)*3));
  return Math.round(clamp(.5*(1-closurePenalty)+.3*(1-jitter)+.2*continuity)*100);
}

function calculateBalance(marks){
  if(marks.length<2)return 100;
  const angles=marks.map(m=>Math.atan2(m.features.cy,m.features.cx));
  const xs=marks.map(m=>Math.cos(angles[0])); // deterministic fallback for single-sided sets
  const centre=marks.reduce((s,m)=>s+Math.atan2(m.features.cy,m.features.cx),0)/marks.length;
  const spread=marks.reduce((s,m)=>s+Math.abs(Math.atan2(Math.sin(Math.atan2(m.features.cy,m.features.cx)-centre),Math.cos(Math.atan2(m.features.cy,m.features.cx)-centre))),0)/marks.length;
  return Math.round(clamp(1-spread/Math.PI)*100);
}

export function candidateSigns(mark){
  const f=mark.features;
  const all=[
    ["Bolt",mark.family==="zigzag"?.84:.2,"directional"],
    ["Column",mark.family==="vertical-line"?.78:.25,"directional"],
    ["Levitation",mark.family==="vertical-line"&&f.directness<.55?.68:.2,"directional"],
    ["Pull",mark.family==="horizontal-line"&&f.directness<.65?.66:.2,"directional"],
    ["Diamond",mark.family==="loop"&&f.circularity>.7?.74:.22,"shape"],
    ["Crush",mark.family==="loop"&&f.sharpTurns>10?.58:.18,"non-directional"],
    ["Dispersion",mark.family==="sweep"?.72:.22,"directional"],
    ["Radial",mark.family==="radial"?.65:.2,"semi-directional"],
    ["Convergence",mark.family==="sweep"&&f.turningSum<0?.55:.2,"directional"]
  ];
  return all.sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name,confidence,group])=>({name,confidence,group}));
}

export function enrichMarks(topology){
  return topology.marks.map(m=>{
    const candidates=candidateSigns(m);
    return {...m,candidates,semantic:candidates[0]?.name||"Unresolved sign",confidence:candidates[0]?.confidence||0,ambiguous:(candidates[0]?.confidence||0)<.65||(candidates[0]?.confidence-candidates[1]?.confidence<.12)};
  });
}


const SIGIL_CANDIDATES=[["Fire","primary-element"],["Water","primary-element"],["Earth","primary-element"],["Wind","primary-element"],["Light","fire-variant"],["Repetition","modifier"],["Purification","modifier"],["Guidance","modifier"],["Calling","modifier"],["Sword","form"],["Bridging","link"]];
export function classifyCentralSigil(strokes,primaryRingIndex=-1){
  const candidates=[];
  const ring=primaryRingIndex>=0?bounds(strokes[primaryRingIndex]):null;
  const inner=strokes.map((p,index)=>({index,p,b:bounds(p)})).filter(x=>x.index!==primaryRingIndex).map(x=>({...x,distFromCentre:ring?Math.hypot(x.b.cx-ring.cx,x.b.cy-ring.cy):Math.hypot(x.b.cx,x.b.cy)}));
  if(!inner.length)return {status:"missing",label:"No central sigil detected",confidence:0,candidates:[]};
  const ordered=inner.slice().sort((a,b)=>a.distFromCentre-b.distFromCentre);
  const central=ordered[0], maxRadius=ring?Math.max(ring.w,ring.h)*.34:Math.max(central.b.w,central.b.h)*1.6;
  const centrality=clamp(1-central.distFromCentre/(maxRadius||1));
  const f=strokeFeatures(central.p), closed=f.closure<.35, compact=clamp(1-Math.max(f.w,f.h)/(Math.max(ring?.w||f.w*2,ring?.h||f.h*2)*.45));
  const shape=[];
  shape.push(["Fire",.25+(closed?.18:0)+f.circularity*.12]); shape.push(["Water",.25+(f.turns<8?.15:0)+(f.w>f.h?.08:0)]); shape.push(["Earth",.25+(f.circularity>.7?.12:0)+Math.min(.12,f.sharpTurns*.01)]); shape.push(["Wind",.25+(f.turns>4?.14:0)+Math.min(.1,Math.abs(f.turningSum)/20)]); shape.push(["Light",.2+(f.directness>.55?.12:0)]);
  const scored=shape.map(([label,score])=>({label,confidence:clamp(score*.55+centrality*.25+compact*.2),source:"geometric candidate"})).sort((a,b)=>b.confidence-a.confidence);
  const top=scored[0],second=scored[1];
  return {status:top.confidence>=.62?"recognised":"ambiguous",stroke:central.index,label:top.confidence>=.45?top.label:"Unknown sigil",confidence:top.confidence,candidates:scored.slice(0,5),centrality,compact};
}
export function compileSpell(topology,sigil,ink){
  const detected=classifyCentralSigil(topology.strokes||[],topology.primaryRing);
  const marks=enrichMarks(topology);
  const names=marks.map(m=>m.semantic).filter(Boolean);
  const force=clamp(.3+marks.filter(m=>/Column|Crush|Convergence|Bolt/i.test(m.semantic)).length*.12);
  const spread=clamp(.25+marks.filter(m=>/Dispersion|Radial|Rain/i.test(m.semantic)).length*.18);
  const range=clamp(.3+marks.filter(m=>/Levitation|Column|Pull|Launch/i.test(m.semantic)).length*.15);
  const stability=clamp(topology.quality/100*.55+topology.balance/100*.25+(topology.ring?.confidence||0)*.2);
  const effect={Fire:"heat / flame",Water:"water manifestation",Earth:"earth / material",Wind:"air / pressure",Light:"light"}[detected.label]||"unresolved manifestation";
  return {sigil:detected.label,detectedSigil:detected,effect,signs:names,force:Math.round(force*100),spread:Math.round(spread*100),range:Math.round(range*100),stability:Math.round(stability*100),duration:Math.round(20+ink*.65),activation:(topology.ring?.confidence||0)>=.8?"complete":"prepared",marks};
}
