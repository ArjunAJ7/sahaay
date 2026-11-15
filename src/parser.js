// Medication quick-add parser.
// SAFETY CONTRACT: this parser only extracts what the user EXPLICITLY wrote.
// It never infers dosage, frequency, or clock times. Anything not found is
// returned as null and the UI must require the user to supply it explicitly.
// Sahaay is not a medical device and gives no medical advice.

const FREQ_WORDS = [
  { re: /\bonce\s+(a|per)\s+(day|daily)\b|\bonce\s+daily\b/i, n: 1 },
  { re: /\btwice\s+(a|per)\s+(day|daily)\b|\btwice\s+daily\b/i, n: 2 },
  { re: /\bthrice\s+(a|per)\s+(day|daily)\b|\bthrice\s+daily\b|\bthree\s+times\s+(a|per)\s+day\b/i, n: 3 },
  { re: /\bfour\s+times\s+(a|per)\s+day\b/i, n: 4 },
];

const DOSAGE_RE = /\b(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|units?|tablets?|tabs?|capsules?|caps?|drops?|puffs?))\b/i;

function parseQuickAdd(text) {
  const out = { name: null, dosage: null, instructions: null, dosesPerDay: null, warnings: [] };
  if (!text || !text.trim()) return out;
  let rest = ' ' + text.trim() + ' ';

  for (const f of FREQ_WORDS) {
    const m = rest.match(f.re);
    if (m) { out.dosesPerDay = f.n; rest = rest.replace(m[0], ' '); break; }
  }
  const dm = rest.match(DOSAGE_RE);
  if (dm) { out.dosage = dm[1].trim(); rest = rest.replace(dm[0], ' '); }

  const im = rest.match(/\b(before|after|with)\s+(food|meals?|breakfast|lunch|dinner)\b/i);
  if (im) { out.instructions = im[0].toLowerCase(); rest = rest.replace(im[0], ' '); }

  const name = rest.replace(/[,.;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name) out.name = name;
  if (out.dosesPerDay == null) out.warnings.push('frequency_not_found');
  if (out.name == null) out.warnings.push('name_not_found');
  return out;
}

module.exports = { parseQuickAdd };
