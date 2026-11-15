const express = require('express');
const store = require('./store');
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

// Async handler wrapper: forwards rejections to the error handler instead of hanging.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function logActivity(profileId, actor, action) {
  return store.addActivity(profileId, actor, action);
}

async function currentMember(req) {
  const t = (req.headers.cookie || '').match(/sahaay=([a-f0-9]{48})/);
  if (!t) return null;
  return (await store.getSessionMember(t[1])) || null;
}
async function requireMember(req, res) {
  const m = await currentMember(req);
  if (!m) { res.redirect('/'); return null; }
  return m;
}
async function setSession(res, memberId) {
  const t = token();
  await store.createSession(t, memberId);
  res.set('Set-Cookie', `sahaay=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

app.get('/', h(async (req, res) => {
  const m = await currentMember(req);
  if (m) return res.redirect('/app');
  res.send(views.landing());
}));

app.get('/demo', h(async (req, res) => {
  const p = await ensureDemo(store);
  const viewer = await store.firstFamilyMember(p.id);
  await setSession(res, viewer.id);
  res.redirect('/app');
}));

app.post('/profiles', h(async (req, res) => {
  const { elder_name, name, role, email, passcode } = req.body;
  if (!elder_name?.trim() || !name?.trim() || !validEmail(email) || !/^\d{4,8}$/.test(passcode || '')) {
    return res.status(400).send(views.landing('Please fill every field correctly (passcode: 4-8 digits).'));
  }
  const salt = newSalt();
  const code = profileCode();
  const p = await store.createProfile({ code, elder_name: elder_name.trim(), passcode_hash: hashPasscode(passcode, salt), salt });
  const member = await store.addMember({
    profile_id: p.id, name: name.trim(),
    role: ['elder', 'caretaker', 'family'].includes(role) ? role : 'family', email: email.trim(),
  });
  await logActivity(p.id, name.trim(), 'created this care profile');
  await setSession(res, member.id);
  res.redirect('/app');
}));


// Brute-force protection for passcode entry: max 10 failed join attempts per IP per 10 minutes.
const joinFails = new Map();
const JOIN_WINDOW_MS = 10 * 60 * 1000, JOIN_MAX_FAILS = 10;
function joinRateCheck(ip) {
  const now = Date.now();
  let e = joinFails.get(ip);
  if (!e || now > e.resetAt) { e = { fails: 0, resetAt: now + JOIN_WINDOW_MS }; joinFails.set(ip, e); }
  return e.fails < JOIN_MAX_FAILS ? e : null;
}
function joinRateRecord(entry) { entry.fails += 1; }

app.post('/join', h(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const bucket = joinRateCheck(ip);
  if (!bucket) return res.status(429).send(views.landing('Too many attempts. Please wait a few minutes and try again.'));
  const { code, passcode, name, role, email } = req.body;
  const p = await store.getProfileByCode((code || '').trim().toUpperCase());
  if (!p || !verifyPasscode(passcode || '', p.salt, p.passcode_hash) || !name?.trim() || !validEmail(email)) {
    joinRateRecord(bucket);
    return res.status(403).send(views.landing('Profile code, passcode or details did not match. Please check and try again.'));
  }
  const member = await store.addMember({
    profile_id: p.id, name: name.trim(),
    role: ['elder', 'caretaker', 'family'].includes(role) ? role : 'family', email: email.trim(),
  });
  await logActivity(p.id, name.trim(), 'joined the care profile');
  await setSession(res, member.id);
  res.redirect('/app');
}));

app.get('/logout', h(async (req, res) => {
  const t = (req.headers.cookie || '').match(/sahaay=([a-f0-9]{48})/);
  if (t) await store.deleteSession(t[1]);
  res.set('Set-Cookie', 'sahaay=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/');
}));

app.get('/app', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  await reminders.dueRowsForToday(store);
  const today = todayStr();
  const [doses, appts, wk, activity] = await Promise.all([
    store.dosesForProfileDate(m.pid, today),
    store.upcomingAppointments(m.pid),
    store.adherenceWeek(m.pid),
    store.listActivity(m.pid, 8),
  ]);
  const simple = m.role === 'elder' || req.query.simple === '1';
  res.send(views.dashboard({
    profile: { elder_name: m.elder_name, code: m.code }, member: m, doses, appts,
    adherence: wk, activity, simple,
  }));
}));

app.post('/app/doses/:id/taken', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const d = await store.getDose(req.params.id);
  if (d && d.profile_id === m.pid && d.status !== 'taken') {
    // Atomic guard: only the first mark wins, even on double-submit races.
    const changed = await store.markDoseTakenIfPending(d.id, m.name);
    if (changed > 0) await logActivity(m.pid, m.name, `marked ${d.med_name} (${d.scheduled_time}) as taken`);
  }
  res.redirect('/app');
}));

app.get('/app/meds', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const meds = await store.listMedications(m.pid);
  res.send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds }));
}));

app.post('/app/meds/parse', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const meds = await store.listMedications(m.pid);
  res.send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds, parsed: parseQuickAdd(req.body.quick), quick: req.body.quick }));
}));

app.post('/app/meds', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const b = req.body;
  const times = [b.time1, b.time2, b.time3, b.time4].filter(Boolean);
  const meds = await store.listMedications(m.pid);
  if (b.confirmed !== '1' || !b.name?.trim() || !times.length || !times.every(validHHMM) || !/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) {
    return res.status(400).send(views.medsPage({ profile: { elder_name: m.elder_name }, member: m, meds, err: 'Please confirm every required field, including exact times.' }));
  }
  await store.addMedication({
    profile_id: m.pid, name: b.name.trim(), dosage: (b.dosage || '').trim(),
    instructions: (b.instructions || '').trim(), times, start_date: b.start_date,
    end_date: b.end_date || null, created_by: m.name,
  });
  await logActivity(m.pid, m.name, `added medicine ${b.name.trim()} (${times.join(', ')})`);
  res.redirect('/app/meds');
}));

app.get('/app/meds/:id/archive', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const med = await store.getMedication(req.params.id);
  if (!med || med.profile_id !== m.pid) return res.redirect('/app/meds');
  res.send(views.layout('Archive schedule', `
<h1>Archive this schedule?</h1>
<div class="card">
<p><strong>${esc(med.name)}</strong> ${esc(med.dosage || '')} - ${JSON.parse(med.times).join(', ')}</p>
<p>Archiving <strong>stops the reminders</strong> for this medicine and moves the schedule to the archived list. The full history is kept.</p>
<p><strong>This changes nothing about the treatment itself.</strong> Medicines should only be started, changed or stopped when a doctor says so - Sahaay never makes that decision.</p>
<form method="post" action="/app/meds/${med.id}/archive" class="inline"><button class="btn-danger">Yes, archive this schedule</button></form>
<a class="btn-ghost" href="/app/meds">No, keep it</a>
</div>`, { member: m }));
}));

app.post('/app/meds/:id/archive', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const med = await store.getMedication(req.params.id);
  if (med && med.profile_id === m.pid) {
    await store.stopMedication(med.id);
    await logActivity(m.pid, m.name, `archived the schedule for ${med.name}`);
  }
  res.redirect('/app/meds');
}));

app.get('/app/appointments', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const appts = await store.listAppointments(m.pid, 30);
  const rows = appts.map(a => `<li><strong>${esc(String(a.appt_at).replace('T', ' '))}</strong> - ${esc(a.title)}${a.doctor ? ' (' + esc(a.doctor) + ')' : ''}${a.location ? ', ' + esc(a.location) : ''}${a.notes ? `<br><span class="hint">${esc(a.notes)}</span>` : ''}</li>`).join('');
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
}));

app.post('/app/appointments', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const { title, doctor, location, appt_at, notes } = req.body;
  if (title?.trim() && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(appt_at || '')) {
    await store.addAppointment({
      profile_id: m.pid, title: title.trim(), doctor: (doctor || '').trim(),
      location: (location || '').trim(), appt_at, notes: (notes || '').trim(),
    });
    await logActivity(m.pid, m.name, `added appointment ${title.trim()} at ${appt_at.replace('T', ' ')}`);
  }
  res.redirect('/app/appointments');
}));

app.get('/app/members', h(async (req, res) => {
  const m = await requireMember(req, res); if (!m) return;
  const members = await store.listMembers(m.pid);
  const rows = members.map(x => `<li><strong>${esc(x.name)}</strong> (${esc(x.role)}) - ${esc(x.email)}</li>`).join('');
  res.send(views.layout('Family & caretakers', `
<h1>Family & caretakers</h1>
<p class="lede">Everyone below can view and manage ${esc(m.elder_name)}'s care profile with the family passcode. Profile code: <strong class="code">${esc(m.code)}</strong></p>
<ul>${rows}</ul>
<p class="hint">To add someone, have them open Sahaay and choose "Join a care profile" with the profile code and passcode.</p>`, { member: m }));
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Error handler: never leak internals.
app.use((err, req, res, next) => {
  console.error('[sahaay]', err.message);
  res.status(500).send(views.layout('Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a moment.</p>', {}));
});

const PORT = process.env.PORT || 8080;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sahaay listening on :${PORT}`);
    reminders.start(store, sendMail);
  });
}
module.exports = { app };
