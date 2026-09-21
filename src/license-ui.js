import {licenseTexts} from './license-texts.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function licenseBadge(entry) {
  if (!entry?.reuse) return '';
  return `<button type="button" class="license-badge" data-license="${escape(entry.addr)}" aria-label="View license and reuse terms for ${escape(entry.reuse.name)}"><span class="license-check" aria-hidden="true">✓</span><span>Free to use</span><span class="license-name">${escape(entry.reuse.license)}</span><span aria-hidden="true">↗</span></button>`;
}

export function licenseStrip(entry) {
  if (!entry?.reuse) return '';
  return `<div class="license-strip">${licenseBadge(entry)}<a class="license-source" href="${escape(entry.reuse.codeUrl)}" target="_blank" rel="noopener noreferrer">Source code ↗</a></div><p class="license-caption">${escape(entry.reuse.name)} · ${escape(entry.reuse.shareRequirement)}</p>`;
}

export function licensePanel(entry) {
  const license = entry.reuse;
  return `<section class="license-panel" aria-label="Software license and reuse">
    <div class="license-panel-heading"><div><p class="small mono">LICENSED SOURCE</p><h3>${escape(license.name)}</h3></div><span class="license-tag">${escape(license.license)}</span></div>
    <p class="license-intro">Free to use, change, and build on—including commercially.</p>
    <ul class="license-permissions"><li><span aria-hidden="true">✓</span> Use commercially</li><li><span aria-hidden="true">✓</span> Modify the code</li><li><span aria-hidden="true">✓</span> Share under the license</li></ul>
    <div class="license-condition"><strong>When you share your version</strong><p>${escape(license.notice)}</p></div>
    <details class="license-scope"><summary>What this license covers</summary><p>${escape(license.scope)}</p></details>
    <details class="license-full"><summary>Read full license text</summary>${license.licenseTermsText?`<pre class="license-text" tabindex="0" aria-label="License notice">${escape(license.licenseText)}</pre>`:''}<pre class="license-text" tabindex="0" aria-label="${escape(license.license)} license text">${escape(license.licenseTermsText || license.licenseText || licenseTexts[license.license])}</pre></details>
    ${(license.additionalNotices||[]).map(notice=>`<details class="license-full"><summary>${escape(notice.title)}</summary><pre class="license-text" tabindex="0" aria-label="${escape(notice.title)}">${escape(notice.text)}</pre><a href="${escape(notice.url)}" target="_blank" rel="noopener noreferrer">Read the original notice ↗</a></details>`).join('')}
    <div class="license-actions"><a href="${escape(license.codeUrl)}" target="_blank" rel="noopener noreferrer">Browse source code ↗</a><a href="${escape(license.licenseUrl)}" target="_blank" rel="noopener noreferrer">Read the full license ↗</a></div>
  </section>`;
}
