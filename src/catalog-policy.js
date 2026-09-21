// Publication requires an explicit review of the exact software release.
// A familiar license name, free download, or source link alone is insufficient.
const reviewedLicenses = new Set(['GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'MIT X-11 / Udanax', 'MIT', 'Apache-2.0', 'CC0-1.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const httpsLink = value => {
  try {return typeof value === 'string' && new URL(value).protocol === 'https:';} catch {return false;}
};
export function isFreeToUseEntry(entry) {
  const license = entry?.reuse;
  return Boolean(license && license.reviewStatus === 'approved' && reviewedLicenses.has(license.licenseId || license.license)
    && ['use', 'modify', 'redistribute', 'commercial', 'royaltyFree'].every(right => license.permissions?.[right] === true)
    && license.name && license.notice && license.scope && license.shareRequirement
    && /^\d{4}-\d{2}-\d{2}$/.test(license.reviewedOn || '')
    && httpsLink(license.codeUrl) && httpsLink(license.licenseUrl)
    && Array.isArray(entry.sources) && entry.sources.length > 0
    && entry.sources.every(source => source.title && httpsLink(source.url)));
}
