// Nationality of the person in a Fayda eKYC result. Fayda gives it as an identity attribute
// (nationality_eng / nationality); without one, a residence status that says the person is a
// foreigner still marks them as a foreign national. '' when Fayda says nothing about it.

const FOREIGN_RESIDENCE = /foreign|non[\s-]?citizen|alien|expat/i;
const ETHIOPIAN = new Set(['ethiopia', 'ethiopian', 'et', 'eth', 'ኢትዮጵያ', 'ኢትዮጵያዊ', 'ኢትዮጵያዊት']);

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.eng === 'string') return value.eng.trim();
  return '';
}

function nationalityOf(identity) {
  if (!identity || typeof identity !== 'object') return '';
  for (const key of ['nationality_eng', 'nationality', 'Nationality', 'nationality_en']) {
    const value = text(identity[key]);
    if (value) return value;
  }
  const residence = text(identity.residenceStatus_eng) || text(identity.residenceStatus);
  return FOREIGN_RESIDENCE.test(residence) ? 'Foreign national' : '';
}

/** A nationality other than Ethiopia (any case); none given counts as Ethiopian */
function isForeignNational(nationality) {
  const n = String(nationality || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return !!n && !ETHIOPIAN.has(n);
}

module.exports = { nationalityOf, isForeignNational };
