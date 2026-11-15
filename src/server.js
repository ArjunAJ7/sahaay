const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { hashPasscode, newSalt, verifyPasscode, profileCode, token, todayStr, validEmail, validHHMM, esc } = require('./util');
const views = require('./views');
const { parseQuickAdd } = require('./parser');
const { sendMail } = require('./mailer');
const reminders = require('./reminders');
const { ensureDemo } = require('./demo');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use('/static', express.static(require('path').join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Security headers (simple, effective)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

function logActivity(profileId, actor, action) {
  db.prepare('INSERT INTO activity (profile_id, actor, action) VALUES (?,?,?)').run(profileId, actor, action);
}

function currentMember(req) {
  const t = (req.headers.cookie || '').match(/sahaay=([a-f0-9]{48})/);
  if (!t) return null;
  const row = db.prepare(
    `SELECT m.*, p.elder_name, p.code, p.id AS pid FROM sessions s
     JOIN members m ON m.id = s.member_id JOIN profiles p ON p.id = m.profile_id
     WHERE s.token = ?`).get(t[1]);
  return row || null;
}
function requireMember(req, res) {
  const m = currentMember(req);
  if (!m) { res.redirect('/'); return null; }
  return m;
}
function setSession(res, memberId) {
  const t = token();
  db.prepare('INSERT INTO sessions (token, member_id) VALUES (?,?)').run(t, memberId);
  res.set('Set-Cookie', `sahaay=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

app.get('/', (req, res) => {
  const m = currentMember(req);
  if (m) return res.redirect('/app');
  res.send(views.landing());
});

app.get('/demo', (req, res) => {
  const p = ensureDemo(db);
  let viewer = db.prepare("SELECT * FROM members WHERE profile_id = ? AND role = 'family' ORDER BY id LIMIT 1").get(p.id);
  setSession(res, viewer.id);
  res.redirect('/app');
});

app.post('/profiles', (req, res) => {
  const { elder_name, name, role, email, passcode } = req.body;
  if (!elder_name?.trim() || !name?.trim() || !validEmail(email) || !/^\d{4,8}$/.test(passcode || '')) {
    return res.status(400).send(views.landing('Please fill every field correctly (passcode: 4-8 digits).'));
  }
  const salt = newSalt();
  const code = profileCode();
  const info = db.prepare('INSERT INTO profiles (code, elder_name, passcode_hash, salt) VALUES (?,?,?,?)')
    .run(code, elder_name.trim(), hashPasscode(passcode, salt), salt);
  const mid = db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)')
    .run(info.lastInsertRowid, name.trim(), ['elder', 'caretaker', 'family'].includes(role) ? role : 'family', email.trim()).lastInsertRowid;
  logActivity(info.lastInsertRowid, name.trim(), 'created this care profile');
  setSession(res, mid);
  res.redirect('/app');
});

app.post('/join', (req, res) => {
  const { code, passcode, name, role, email } = req.body;
  const p = db.prepare('SELECT * FROM profiles WHERE code = ?').get((code || '').trim().toUpperCase());
  if (!p || !verifyPasscode(passcode || '', p.salt, p.passcode_hash) || !name?.trim() || !validEmail(email)) {
    return res.status(403).send(views.landing('Profile code, passcode or details did not match. Please check and try again.'));
  }
  const mid = db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)')
    .run(p.id, name.trim(), ['elder', 'caretaker', 'family'].includes(role) ? role : 'family', email.trim()).lastInsertRowid;
  logActivity(p.id, name.trim(), 'joined the care profile');
  setSession(res, mid);
  res.redirect('/app');
});

app.get('/logout', (req, res) => {
  const t = (req.headers.cookie || '').match(/sahaay=([a-f0-9]{48})/);
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t[1]);
  res.set('Set-Cookie', 'sahaay=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/');
});

app.get('/app', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  reminders.dueRowsForToday(db);
  const today = todayStr();
  const doses = db.prepare(
    `SELECT d.*, mt.name AS med_name, mt.dosage, mt.instructions FROM dose_log d
     JOIN medications mt ON mt.id = d.medication_id
     WHERE mt.profile_id = ? AND d.scheduled_date = ? ORDER BY d.scheduled_time`).all(m.pid, today);
  const appts = db.prepare(
    `SELECT * FROM appointments WHERE profile_id = ? AND appt_at >= datetime('now','localtime','-1 hour')
     ORDER BY appt_at LIMIT 5`).all(m.pid);
  const wk = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='taken' THEN 1 ELSE 0 END) AS taken
     FROM dose_log d JOIN medications mt ON mt.id = d.medication_id
     WHERE mt.profile_id = ? AND d.scheduled_date >= date('now','localtime','-6 days')`).get(m.pid);
  const activity = db.prepare('SELECT * FROM activity WHERE profile_id = ? ORDER BY id DESC LIMIT 8').all(m.pid);
  const simple = m.role === 'elder' || req.query.simple === '1';
  res.send(views.dashboard({
    profile: { elder_name: m.elder_name, code: m.code }, member: m, doses, appts,
    adherence: { taken: wk.taken || 0, total: wk.total || 0 }, activity, simple,
  }));
});

app.post('/app/doses/:id/taken', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const d = db.prepare(`SELECT d.*, mt.profile_id, mt.name AS med_name FROM dose_log d JOIN medications mt ON mt.id = d.medication_id WHERE d.id = ?`).get(req.params.id);
  if (d && d.profile_id === m.pid && d.status !== 'taken') {
    db.prepare(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime'), taken_by=? WHERE id=?`).run(m.name, d.id);
    logActivity(m.pid, m.name, `marked ${d.med_name} (${d.scheduled_time}) as taken`);
  }
  res.redirect('/app');
});

app.get('/app/meds', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const meds = db.prepare('SELECT * FROM medications WHERE profile_id = ? ORDER BY active DESC, name').all(m.pid);
  res.send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds }));
});

app.post('/app/meds/parse', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const meds = db.prepare('SELECT * FROM medications WHERE profile_id = ? ORDER BY active DESC, name').all(m.pid);
  res.send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds, parsed: parseQuickAdd(req.body.quick), quick: req.body.quick }));
});

app.post('/app/meds', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const b = req.body;
  const times = [b.time1, b.time2, b.time3, b.time4].filter(Boolean);
  const meds = db.prepare('SELECT * FROM medications WHERE profile_id = ? ORDER BY active DESC, name').all(m.pid);
  if (b.confirmed !== '1' || !b.name?.trim() || !times.length || !times.every(validHHMM) || !/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) {
    return res.status(400).send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds, err: 'Please confirm every required field, including exact times.' }));
  }
  db.prepare('INSERT INTO medications (profile_id, name, dosage, instructions, times, start_date, end_date, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(m.pid, b.name.trim(), (b.dosage || '').trim(), (b.instructions || '').trim(), JSON.stringify(times), b.start_date, b.end_date || null, m.name);
  logActivity(m.pid, m.name, `added medicine ${b.name.trim()} (${times.join(', ')})`);
  res.redirect('/app/meds');
});

app.post('/app/meds/:id/stop', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const med = db.prepare('SELECT * FROM medications WHERE id = ? AND profile_id = ?').get(req.params.id, m.pid);
  if (med) { db.prepare('UPDATE medications SET active = 0 WHERE id = ?').run(med.id); logActivity(m.pid, m.name, `stopped medicine ${med.name}`); }
  res.redirect('/app/meds');
});

app.get('/app/appointments', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const appts = db.prepare('SELECT * FROM appointments WHERE profile_id = ? ORDER BY appt_at DESC LIMIT 30').all(m.pid);
  const rows = appts.map(a => `<li><strong>${esc(a.appt_at.replace('T', ' '))}</strong> - ${esc(a.title)}${a.doctor ? ' (' + esc(a.doctor) + ')' : ''}${a.location ? ', ' + esc(a.location) : ''}${a.notes ? `<br><span class="hint">${esc(a.notes)}</span>` : ''}</li>`).join('');
  res.send(views.layout('Appointments', `
<h1>Appointments for ${esc(m.elder_name)}</h1>
<ul class="appts">${rows || '<li>None yet.</li>'}</ul>
<section class="card"><h2>Add an appointment</h2>
<form method="post" action="/app/appointments">
  <label>Title <input name="title" required placeholder="e.g. Cardiology check-up"></label>
  <label>Doctor (optional) <input name="doctor"></label>
  <label>Location (optional) <input name="location"></label>
  <label>Date and time <input type="datetime-local" name="appt_at" required></label>
  <label>Notes (optional) <input name="notes"></label>
  <button type="submit">Save appointment</button>
</form></section>`, { member: m }));
});

app.post('/app/appointments', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const { title, doctor, location, appt_at, notes } = req.body;
  if (title?.trim() && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(appt_at || '')) {
    db.prepare('INSERT INTO appointments (profile_id, title, doctor, location, appt_at, notes) VALUES (?,?,?,?,?,?)')
      .run(m.pid, title.trim(), (doctor || '').trim(), (location || '').trim(), appt_at, (notes || '').trim());
    logActivity(m.pid, m.name, `added appointment ${title.trim()} at ${appt_at.replace('T', ' ')}`);
  }
  res.redirect('/app/appointments');
});

app.get('/app/members', (req, res) => {
  const m = requireMember(req, res); if (!m) return;
  const members = db.prepare('SELECT name, role, email, created_at FROM members WHERE profile_id = ? ORDER BY id').all(m.pid);
  const rows = members.map(x => `<li><strong>${esc(x.name)}</strong> (${esc(x.role)}) - ${esc(x.email)}</li>`).join('');
  res.send(views.layout('Family & caretakers', `
<h1>Family & caretakers</h1>
<p class="lede">Everyone below can view and manage ${esc(m.elder_name)}'s care profile with the family passcode. Profile code: <strong class="code">${esc(m.code)}</strong></p>
<ul>${rows}</ul>
<p class="hint">To add someone, have them open Sahaay and choose "Join a care profile" with the profile code and passcode.</p>`, { member: m }));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sahaay listening on :${PORT}`);
    reminders.start(db, sendMail);
  });
}
module.exports = { app };
