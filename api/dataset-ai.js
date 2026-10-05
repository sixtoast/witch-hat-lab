const MODEL=process.env.DATASET_AI_MODEL||"openai/gpt-5.6-luna";
const GATEWAY="https://ai-gateway.vercel.sh/v1/chat/completions";
const WIKI_BASE="https://witchhatatelier.telepedia.net/wiki/Special:Redirect/file/";

const labels=["Fire","Water","Earth","Wind","Light","Other","Unknown","Not a glyph"];
const types=["Sigil","Sign","Ring","Full spell","Not a glyph","Unknown"];

function jsonSchema(){
  return {
    type:"json_schema",
    json_schema:{
      name:"witch_hat_dataset_annotation",
      description:"A cautious annotation proposal for a Witch Hat Atelier glyph dataset. This is advisory only.",
      strict:true,
      schema:{
        type:"object",
        additionalProperties:false,
        properties:{
          identity:{type:"string",enum:labels},
          type:{type:"string",enum:types},
          confidence:{type:"number",minimum:0,maximum:1},
          quality:{type:"integer",minimum:1,maximum:5},
          summary:{type:"string"},
          components:{type:"array",items:{type:"string"}},
          noise:{type:"string",enum:["low","medium","high","unknown"]},
          warnings:{type:"array",items:{type:"string"}}
        },
        required:["identity","type","confidence","quality","summary","components","noise","warnings"]
      }
    }
  };
}

async function imageDataUrl(file){
  const url=WIKI_BASE+encodeURIComponent(file);
  const r=await fetch(url,{redirect:"follow"});
  if(!r.ok)throw new Error("Could not fetch the reference image.");
  const contentType=(r.headers.get("content-type")||"image/png").split(";")[0];
  const bytes=Buffer.from(await r.arrayBuffer());
  if(bytes.length>8_000_000)throw new Error("Reference image is too large for AI analysis.");
  return "data:"+contentType+";base64,"+bytes.toString("base64");
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!process.env.AI_GATEWAY_API_KEY&&!process.env.VERCEL_OIDC_TOKEN)return res.status(503).json({error:"AI Dataset Assistant is not configured. Add AI_GATEWAY_API_KEY in Vercel."});
  try{
    const body=typeof req.body==="string"?JSON.parse(req.body):req.body||{};
    const candidate=body.candidate||{};
    if(!candidate.file)return res.status(400).json({error:"Candidate image is required."});
    const image=await imageDataUrl(String(candidate.file));
    const prompt=[
      "You are the Dataset Assistant for Witch Hat Lab.",
      "Your job is to propose annotations for a human curator, not to decide ground truth.",
      "Analyse only what is visibly present in the supplied image.",
      "Do not invent hidden strokes, canon meanings, or spell effects.",
      "Distinguish an isolated sigil/sign/ring from a full spell image.",
      "If the image contains a highlighted glyph inside a larger seal, describe it as a component of a full spell unless the requested evidence clearly isolates it.",
      "Quality measures usefulness as a visual dataset reference: 5 means exceptionally clean and structurally clear; 1 means unusable.",
      "Be conservative. When identity is uncertain, choose Unknown and explain why.",
      "The human reviewer will see your proposal and may reject every field.",
      "Candidate source hint (not ground truth): "+String(candidate.label||"Unknown"),
      "Candidate kind hint (not ground truth): "+String(candidate.kind||"unknown"),
      "Candidate filename: "+String(candidate.file)
    ].join("\n");

    const gatewayBody={
      model:MODEL,
      messages:[{
        role:"user",
        content:[
          {type:"text",text:prompt},
          {type:"image_url",image_url:{url:image,detail:"high"}}
        ]
      }],
      response_format:jsonSchema(),
      stream:false
    };
    const r=await fetch(GATEWAY,{method:"POST",headers:{
      Authorization:"Bearer "+(process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN),
      "Content-Type":"application/json"
    },body:JSON.stringify(gatewayBody)});
    const raw=await r.text();
    let data={};try{data=raw?JSON.parse(raw):{}}catch{}
    if(!r.ok)return res.status(r.status||502).json({error:data?.error?.message||"AI Gateway request failed."});
    const text=data?.choices?.[0]?.message?.content;
    if(!text)throw new Error("AI returned no annotation.");
    const result=JSON.parse(text);
    return res.status(200).json(result);
  }catch(e){
    return res.status(500).json({error:e.message||"AI analysis failed."});
  }
}

// Vercel redeploy marker: ensure newly configured production environment variables are included.
