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

// A true enclosing ring should have nearly constant radius from its centre.
// This is deliberately stricter than bbox circularity: a closed sigil can be
// roughly square/circular without being an enclosing ring.
export function radialCircularity(points){
  if(points.length<8)return 0;
  const b=bounds(points);
  const radii=points.map(p=>Math.hypot(p.x-b.cx,p.y-b.cy));
  const mean=radii.reduce((s,r)=>s+r,0)/radii.length||1;
  const variance=radii.reduce((s,r)=>s+(r-mean)**2,0)/radii.length;
  const cv=Math.sqrt(variance)/mean;
  return clamp(1-cv/.18);
}

export function ringScore(points){
  if(points.length<8)return 0;
  const f=strokeFeatures(points);
  const closed=clamp(1-f.closure/.16);
  const radial=radialCircularity(points);
  const smooth=clamp(1-f.sharpTurns/Math.max(10,points.length*.12));
  const coverage=clamp(f.length/(Math.PI*Math.max(f.w,f.h)*.7));
  return clamp(.38*closed+.38*radial+.14*smooth+.10*coverage);
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
  // Never call a lone closed stroke the enclosing ring. A seal ring is a
  // structural boundary around other marks, not simply any closed glyph.
  let primary=-1;
  if(strokes.length>=2){
    const candidate=ranked[0];
    if(candidate?.score>.62){
      const cb=bounds(strokes[candidate.index]);
      const otherMax=Math.max(...strokes.filter((_,i)=>i!==candidate.index).map(p=>Math.max(bounds(p).w,bounds(p).h)),0);
      const candidateSize=Math.max(cb.w,cb.h);
      if(candidateSize>=otherMax*1.45) primary=candidate.index;
    }
  }
  const nested=primary>=0?ranked.filter(x=>x.index!==primary&&x.score>.70).map(x=>x.index):[];
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
  const centre=marks.reduce((s,m)=>s+Math.atan2(m.features.cy,m.features.cx),0)/marks.length;
  const spread=marks.reduce((s,m)=>s+Math.abs(Math.atan2(Math.sin(Math.atan2(m.features.cy,m.features.cx)-centre),Math.cos(Math.atan2(m.features.cy,m.features.cx)-centre))),0)/marks.length;
  return Math.round(clamp(1-spread/Math.PI)*100);
}

export function enrichMarks(topology){
  return topology.marks.map(m=>({
    ...m,
    candidates:[],
    semantic:"Untrained sign",
    confidence:0,
    ambiguous:true,
    recognitionStatus:"untrained"
  }));
}

export function compileSpell(topology,detected,ink){
  const marks=topology.marks||[];
  const recognisedMarks=marks.filter(m=>m.semantic&&m.semantic!=="Untrained sign");
  const names=recognisedMarks.map(m=>m.semantic);
  const force=clamp(.3+recognisedMarks.filter(m=>/Column|Crush|Convergence|Bolt/i.test(m.semantic)).length*.12);
  const spread=clamp(.25+recognisedMarks.filter(m=>/Dispersion|Radial|Rain/i.test(m.semantic)).length*.18);
  const range=clamp(.3+recognisedMarks.filter(m=>/Levitation|Column|Pull|Launch/i.test(m.semantic)).length*.15);
  const stability=clamp(topology.quality/100*.55+topology.balance/100*.25+(topology.ring?.confidence||0)*.2);
  const effect={
    Fire:"heat / flame",
    Water:"water manifestation",
    Earth:"earth / material",
    Wind:"air / pressure"
  }[detected?.label]||"unresolved manifestation";
  return {
    sigil:detected?.label||"Unresolved",
    detectedSigil:detected,
    effect,
    signs:names,
    force:Math.round(force*100),
    spread:Math.round(spread*100),
    range:Math.round(range*100),
    stability:Math.round(stability*100),
    duration:Math.round(20+ink*.65),
    activation:(topology.ring?.confidence||0)>=.8?"complete":"prepared",
    marks
  };
}
