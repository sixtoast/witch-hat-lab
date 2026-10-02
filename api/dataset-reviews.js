const REPO=process.env.GITHUB_REPO||"sixtoast/witch-hat-lab";
const BRANCH=process.env.GITHUB_BRANCH||"main";
const TOKEN=process.env.GITHUB_TOKEN;
const BASE="https://api.github.com";
const allowedIds=new Set([
  "fire-canon","water-canon","earth-canon","wind-canon","fire-anime","water-anime",
  "wind-anime","light-anime","spell-anime","signs-anime","pyreball"
]);

function headers(){return{
  Authorization:"Bearer "+TOKEN,
  Accept:"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28",
  "Content-Type":"application/json"
}}

async function github(path,options={}){
  const r=await fetch(BASE+path,{...options,headers:{...headers(),...(options.headers||{})}});
  const text=await r.text();
  let data={}; try{data=text?JSON.parse(text):{}}catch{data={message:text}};
  if(!r.ok){const e=new Error(data.message||"GitHub request failed");e.status=r.status;throw e}
  return data;
}

function reviewPath(id){return "/repos/"+REPO+"/contents/dataset/reviews/"+id+".json"}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method==="GET"){
    if(!TOKEN)return res.status(503).json({error:"GitHub sync is not configured."});
    try{
      const listing=await github("/repos/"+REPO+"/contents/dataset/reviews?ref="+encodeURIComponent(BRANCH));
      const files=Array.isArray(listing)?listing.filter(x=>x.name.endsWith(".json")):[];
      const entries=await Promise.all(files.map(async f=>{
        const data=await github("/repos/"+REPO+"/contents/"+f.path+"?ref="+encodeURIComponent(BRANCH));
        const decoded=Buffer.from(data.content.replace(/\\n/g,""),"base64").toString("utf8");
        return [f.name.replace(/\\.json$/,""),JSON.parse(decoded)];
      }));
      return res.status(200).json({reviews:Object.fromEntries(entries)});
    }catch(e){
      if(e.status===404)return res.status(200).json({reviews:{}});
      return res.status(e.status||500).json({error:e.message});
    }
  }
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!TOKEN)return res.status(503).json({error:"GitHub sync is not configured."});
  try{
    const body=typeof req.body==="string"?JSON.parse(req.body):req.body||{};
    const id=String(body.candidateId||"");
    const review=body.review;
    if(!allowedIds.has(id))return res.status(400).json({error:"Unknown dataset candidate."});
    if(!review||typeof review!=="object")return res.status(400).json({error:"Review is required."});
    const safe={
      candidateId:id,
      decision:String(review.decision||""),
      label:String(review.label||"Unknown"),
      type:String(review.type||"Unknown"),
      quality:Math.max(1,Math.min(5,Number(review.quality)||1)),
      note:String(review.note||"").slice(0,2000),
      reviewedAt:String(review.reviewedAt||new Date().toISOString()),
      file:String(review.file||""),
      source:String(review.source||"")
    };
    if(!["approved","rejected","skipped"].includes(safe.decision))return res.status(400).json({error:"Invalid review decision."});
    const content=JSON.stringify(safe,null,2)+"\\n";
    let sha;
    try{sha=(await github(reviewPath(id)+"?ref="+encodeURIComponent(BRANCH))).sha}catch(e){if(e.status!==404)throw e}
    const payload={message:"Dataset review: "+id+" ("+safe.decision+")",content:Buffer.from(content,"utf8").toString("base64"),branch:BRANCH};
    if(sha)payload.sha=sha;
    const result=await github(reviewPath(id),{method:"PUT",body:JSON.stringify(payload)});
    return res.status(200).json({ok:true,commitSha:result.commit?.sha||null});
  }catch(e){return res.status(e.status||500).json({error:e.message})}
}