const crypto = require('crypto');

function hashPasscode(passcode, salt) {
  return crypto.scryptSync(String(passcode), salt, 32).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPasscode(passcode, salt, expected) {
  const actual = Buffer.from(hashPasscode(passcode, salt), 'hex');
  const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && crypto.timingSafeEqual(actual, want);
}
function profileCode() {
  // Human-friendly, unambiguous alphabet.
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
function token() { return crypto.randomBytes(24).toString('hex'); }

// Local-time helpers (server TZ; container runs TZ env).
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeStr(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }
function validHHMM(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

module.exports = { hashPasscode, newSalt, verifyPasscode, profileCode, token, todayStr, timeStr, minutesOf, esc, validEmail, validHHMM };
