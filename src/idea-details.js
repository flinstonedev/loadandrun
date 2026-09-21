export const historyLabels = {
  'unrealized-vision': 'Unrealized vision',
  'research-prototype': 'Research prototype',
  'unfinished-direction': 'Unfinished direction',
};

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = (value, minimum = 1) => Array.isArray(value) && value.length >= minimum && value.every(nonempty);
const paragraphs = value => nonempty(value) || strings(value);
const https = value => {try {return new URL(value).protocol === 'https:';} catch {return false;}};

// The corpus must contain usable project briefs, not just a headline and a link.
export function hasDetailedBrief(entry) {
  const d = entry?.details;
  if (!d?.origin || !d.history || !d.whyNow || !d.buildPlan || !Array.isArray(d.references)) return false;
  const refs = new Set(d.references.map(ref=>ref.id));
  const cites = ids => strings(ids) && ids.every(id=>refs.has(id));
  return Boolean(nonempty(d.origin.title) && strings(d.origin.people) && d.origin.year
    && paragraphs(d.origin.summary) && cites(d.origin.sourceIds)
    && historyLabels[d.history.status] && paragraphs(d.history.summary)
    && paragraphs(d.history.whatWasBuilt) && paragraphs(d.history.whatRemains) && cites(d.history.sourceIds)
    && paragraphs(d.whyNow.summary) && strings(d.whyNow.beneficiaries) && cites(d.whyNow.sourceIds)
    && nonempty(d.buildPlan.firstMilestone) && Array.isArray(d.buildPlan.steps) && d.buildPlan.steps.length >= 3
    && d.buildPlan.steps.every(step=>nonempty(step.title)&&nonempty(step.description)&&nonempty(step.deliverable))
    && strings(d.buildPlan.successCriteria,2) && strings(d.buildPlan.nonGoals)
    && Array.isArray(d.buildPlan.roles) && d.buildPlan.roles.length>=2 && d.buildPlan.roles.every(role=>nonempty(role.name)&&nonempty(role.contribution))
    && Array.isArray(d.challenges) && d.challenges.length>=2 && d.challenges.every(risk=>nonempty(risk.title)&&nonempty(risk.description))
    && Array.isArray(d.relatedWork) && d.relatedWork.length>=1 && d.relatedWork.every(work=>nonempty(work.title)&&https(work.url)&&nonempty(work.relationship))
    && d.references.length>=2 && refs.size===d.references.length
    && d.references.every(ref=>nonempty(ref.id)&&nonempty(ref.title)&&https(ref.url)&&nonempty(ref.supports)));
}

export function briefText(entry) {
  const d=entry.details;if(!d)return '';
  return [d.origin.title,d.origin.people,d.origin.year,d.origin.summary,
    d.history.summary,d.history.whatWasBuilt,d.history.whatRemains,
    d.whyNow.summary,d.whyNow.beneficiaries,d.buildPlan.firstMilestone,
    d.buildPlan.steps.map(step=>[step.title,step.description,step.deliverable]),
    d.buildPlan.successCriteria,d.buildPlan.nonGoals,d.buildPlan.roles.map(role=>[role.name,role.contribution]),
    d.challenges.map(challenge=>[challenge.title,challenge.description]),
    d.relatedWork.map(work=>[work.title,work.relationship]),
    d.references.map(reference=>[reference.title,reference.supports])].flat(Infinity).join(' ');
}
