import {readFile,writeFile} from 'node:fs/promises';
import {isFreeToUseEntry} from '../src/catalog-policy.js';
import {hasDetailedBrief} from '../src/idea-details.js';
// Editorial JSON is the canonical input; no design runtime is needed or loaded.
const archive=JSON.parse(await readFile('research/catalog-archive.json','utf8'));
const blueprints=structuredClone(archive.blueprints);
const scopedPeople=structuredClone(archive.people);
for (const blueprint of blueprints) blueprint.domain=blueprint.subdomain || blueprint.domain;
const sourceReview = JSON.parse(await readFile('research/catalog-rights.json', 'utf8'));
for (const blueprint of blueprints) {
  const review = sourceReview.entries[blueprint.addr];
  if (!review) throw new Error('Missing source review for ' + blueprint.addr);
  for (const source of review.addSources) {
    if (!blueprint.sources.some(existing=>existing.url===source.url)) blueprint.sources.push(source);
  }
  if (!blueprint.sources.length) throw new Error('A catalog entry must have source material: ' + blueprint.addr);
}
const published = blueprints.filter(b=>sourceReview.entries[b.addr].decision==='publish');
for (const blueprint of published) {
  const implementation = sourceReview.entries[blueprint.addr].implementation;
  if (!implementation?.codeUrl || !implementation?.licenseUrl || !implementation?.license) throw new Error('Missing licensed implementation: ' + blueprint.addr);
  blueprint.reuse = implementation;
  if (!isFreeToUseEntry(blueprint)) throw new Error('Entry does not meet the free-use publication policy: ' + blueprint.addr);
}
const expansionFiles=['knowledge','programming','networks'];
const additionalIdeas=(await Promise.all(expansionFiles.map(name=>readFile(`research/expanded/${name}.json`,'utf8').then(JSON.parse)))).flat();
const communityIdeas=[...JSON.parse(await readFile('research/community-ideas.json','utf8')),...additionalIdeas];
const patches=JSON.parse(await readFile('research/expanded/existing.json','utf8'));
const detailsById=new Map(patches.map(item=>[item.id,item.details]));
for (const proposal of communityIdeas) {
  const b={id:proposal.id,addr:proposal.id,name:proposal.title,line:proposal.summary,proposed:proposal.opportunity,
    opportunity:proposal.opportunity,existingWork:proposal.existingWork,domain:proposal.domain,tags:proposal.tags,
    details:proposal.details || detailsById.get(proposal.id),
    originalityStatus:proposal.originalityStatus,who:proposal.implementation.name,year:2026,period:'Proposed experiment',
    stalled:'',changed:'',near:'',next:'',originality:'',sources:proposal.sourceMaterial,
    reuse:{...proposal.implementation,attribution:proposal.implementation.notice,notice:proposal.implementation.shareRequirement}};
  if(!isFreeToUseEntry(b))throw new Error('Community proposal lacks reviewed reuse rights: '+proposal.id);
  published.push(b);
}
const publishedIds=new Set();
const topics={
  'Documents and hypertext':'Knowledge & memory','Shared knowledge':'Knowledge & memory','Interoperability':'Knowledge & memory','Collective memory':'Knowledge & memory','Information management':'Knowledge & memory','Knowledge commons':'Knowledge & memory','Digital preservation':'Knowledge & memory',
  'Programming tools':'Programming tools','End-user software':'Programming tools','Software architecture':'Programming tools','Collaborative computation':'Programming tools',
  'Learning technology':'Learning & access','Learning and programming':'Learning & access','Computing education':'Learning & access','Programming access':'Learning & access',
  'Collaboration':'Collaboration','Community coordination':'Collaboration',
  'Data portability':'Data & science','Community data tools':'Data & science','Open science':'Data & science',
  'Personal computing':'Personal computing','Privacy and agency':'Personal computing',
  'Visual computing':'Visual computing','Resilient networks':'Resilient infrastructure','Community infrastructure':'Resilient infrastructure',
};
for(const b of published){
  b.details ||= detailsById.get(b.addr);
  b.subdomain=b.domain;b.domain=topics[b.domain]||b.domain;
  if(publishedIds.has(b.addr))throw new Error('Duplicate idea identity: '+b.addr);
  publishedIds.add(b.addr);
  if(!hasDetailedBrief(b))throw new Error('Incomplete idea brief: '+b.addr);
}
const activeAddresses = new Set(published.map(b=>b.addr));
const publishedPeople = scopedPeople.filter(p=>p.blueprint && activeAddresses.has(p.blueprint));
await writeFile('src/data.json',JSON.stringify({blueprints:published,people:publishedPeople},null,2));
console.log(`${published.length} published blueprints; ${Object.values(sourceReview.entries).filter(r=>r.decision==='hold').length} held; ${publishedPeople.length} linked people`);
