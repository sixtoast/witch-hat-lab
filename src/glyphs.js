// Evidence registry for Witch Hat Lab.
// Only glyphs with documented visual references are eligible for recognition.
// No stroke geometry is invented in this file.

export const VERIFIED_SIGILS=[
  {id:"fire",name:"Fire",kind:"sigil",status:"canon",referenceFile:"Fire sigil.png",source:"https://witchhatatelier.telepedia.net/wiki/Sigils_Explained"},
  {id:"water",name:"Water",kind:"sigil",status:"canon",referenceFile:"Water.png",source:"https://witchhatatelier.telepedia.net/wiki/Sigils_Explained"},
  {id:"earth",name:"Earth",kind:"sigil",status:"canon",referenceFile:"Earth.png",source:"https://witchhatatelier.telepedia.net/wiki/Sigils_Explained"},
  {id:"wind",name:"Wind",kind:"sigil",status:"canon",referenceFile:"Wind (redirect).png",source:"https://witchhatatelier.telepedia.net/wiki/Sigils_Explained"}
];

// Signs are deliberately empty until each visual identity is verified.
// A name or fan classification alone is not enough to create a recogniser template.
export const VERIFIED_SIGNS=[];
export const VERIFIED_GLYPHS=[...VERIFIED_SIGILS,...VERIFIED_SIGNS];
export function glyphById(id){return VERIFIED_GLYPHS.find(g=>g.id===id)||null;}
