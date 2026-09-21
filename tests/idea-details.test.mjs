import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {hasDetailedBrief} from '../src/idea-details.js';
import {isFreeToUseEntry} from '../src/catalog-policy.js';

const data=JSON.parse(await readFile(new URL('../src/data.json',import.meta.url)));
const narrative=d=>[
  d.origin.summary,d.history.summary,d.history.whatWasBuilt,d.history.whatRemains,d.whyNow.summary,
  d.buildPlan.firstMilestone,...d.buildPlan.steps.flatMap(s=>[s.description,s.deliverable]),
  ...d.buildPlan.successCriteria,...d.buildPlan.nonGoals,...d.buildPlan.roles.map(r=>r.contribution),
  ...d.challenges.map(c=>c.description),...d.relatedWork.map(r=>r.relationship),
].flat().join(' ').split(/\s+/).filter(Boolean);

test('the corpus contains substantial, distinct, sourced and freely licensed briefs',()=>{
  assert.ok(data.blueprints.length>=40);
  const milestones=new Set();
  for(const entry of data.blueprints){
    assert.ok(hasDetailedBrief(entry),entry.addr);
    assert.ok(isFreeToUseEntry(entry),entry.addr);
    assert.ok(narrative(entry.details).length>=350,entry.addr+' is too shallow');
    assert.ok(!milestones.has(entry.details.buildPlan.firstMilestone),'Duplicated first milestone: '+entry.addr);
    milestones.add(entry.details.buildPlan.firstMilestone);
    if(entry.reuse.licenseTextSha256)assert.equal(createHash('sha256').update(entry.reuse.licenseText).digest('hex'),entry.reuse.licenseTextSha256,entry.addr+' license evidence changed');
    for(const notice of entry.reuse.additionalNotices||[]){assert.ok(notice.text);assert.equal(new URL(notice.url).protocol,'https:');}
  }
});

test('publication rejects shallow briefs and historical sections with dangling citations',()=>{
  const original=data.blueprints[0];
  assert.equal(hasDetailedBrief(original),true);
  for(const change of [
    entry=>delete entry.details,
    entry=>entry.details.history.sourceIds=['not-a-source'],
    entry=>entry.details.origin.people=[],
    entry=>entry.details.buildPlan.steps=entry.details.buildPlan.steps.slice(0,1),
    entry=>entry.details.buildPlan.roles=[],
    entry=>entry.details.references[0].url='javascript:alert(1)',
    entry=>entry.details.references.push({...entry.details.references[0]}),
  ]){
    const entry=structuredClone(original);change(entry);assert.equal(hasDetailedBrief(entry),false);
  }
});
