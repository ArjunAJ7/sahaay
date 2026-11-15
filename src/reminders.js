// Reminder engine. Runs every minute inside the service (Cloud Run min-instance
// deployment keeps it alive). For each profile it:
//  - creates today's pending dose rows for active medications,
//  - emails UPCOMING-dose reminders 10 min before the scheduled time,
//  - emails MISSED-dose escalations to caretakers/family 30 min after,
//  - emails appointment reminders 24h and 1h before.
// Every email is recorded (reminder_sent / missed_sent flags) so nothing sends twice.
const { todayStr, timeStr, minutesOf } = require('./util');

function dueRowsForToday(db, now = new Date()) {
  const today = todayStr(now);
  const meds = db.prepare(
    `SELECT m.*, p.elder_name, p.code AS profile_code, p.id AS pid
     FROM medications m JOIN profiles p ON p.id = m.profile_id
     WHERE m.active = 1 AND m.start_date <= ? AND (m.end_date IS NULL OR m.end_date >= ?)`
  ).all(today, today);
  const rows = [];
  for (const med of meds) {
    for (const t of JSON.parse(med.times)) {
      db.prepare(
        `INSERT OR IGNORE INTO dose_log (medication_id, scheduled_date, scheduled_time) VALUES (?,?,?)`
      ).run(med.id, today, t);
      rows.push({ med, t });
    }
  }
  return rows;
}

function memberEmails(db, profileId, roles) {
  const ph = roles.map(() => '?').join(',');
  return db.prepare(`SELECT name, email, role FROM members WHERE profile_id = ? AND role IN (${ph})`)
    .all(profileId, ...roles);
}

async function tick(db, sendMail, now = new Date()) {
  dueRowsForToday(db, now);
  const today = todayStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Upcoming + missed doses
  const pending = db.prepare(
    `SELECT d.*, m.name AS med_name, m.dosage, m.instructions, m.profile_id, p.elder_name
     FROM dose_log d JOIN medications m ON m.id = d.medication_id JOIN profiles p ON p.id = m.profile_id
     WHERE d.scheduled_date = ? AND d.status = 'pending'`
  ).all(today);

  for (const d of pending) {
    const schedMin = minutesOf(d.scheduled_time);
    const label = `${d.med_name}${d.dosage ? ' ' + d.dosage : ''}`;
    if (!d.reminder_sent && nowMin >= schedMin - 10 && nowMin < schedMin + 30) {
      const everyone = memberEmails(db, d.profile_id, ['elder', 'caretaker', 'family']);
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: ${label} due at ${d.scheduled_time} for ${d.elder_name}`,
        text: `Hello,\n\n${d.elder_name}'s ${label} is due at ${d.scheduled_time} today${d.instructions ? ` (${d.instructions})` : ''}.\nPlease open Sahaay and mark it taken once done.\n\n- Sahaay\n(Reminder only - schedules are set by the family, not medical advice.)`,
      });
      db.prepare(`UPDATE dose_log SET reminder_sent = 1 WHERE id = ?`).run(d.id);
    }
    if (!d.missed_sent && nowMin >= schedMin + 30) {
      const carers = memberEmails(db, d.profile_id, ['caretaker', 'family']);
      if (carers.length) {
        await sendMail({
          to: carers.map(m => m.email),
          subject: `Sahaay MISSED dose: ${label} (${d.scheduled_time}) - ${d.elder_name}`,
          text: `Hello,\n\n${d.elder_name}'s ${label} scheduled at ${d.scheduled_time} today has NOT been marked taken after 30 minutes.\nPlease check in with them.\n\n- Sahaay`,
        });
      }
      db.prepare(`UPDATE dose_log SET missed_sent = 1, status = 'missed' WHERE id = ? AND status = 'pending'`).run(d.id);
    }
  }

  // Appointments
  const appts = db.prepare(
    `SELECT a.*, p.elder_name FROM appointments a JOIN profiles p ON p.id = a.profile_id
     WHERE (a.remind_24_sent = 0 OR a.remind_1h_sent = 0)`
  ).all();
  for (const a of appts) {
    const at = new Date(a.appt_at);
    const mins = (at - now) / 60000;
    const everyone = memberEmails(db, a.profile_id, ['elder', 'caretaker', 'family']);
    if (!a.remind_24_sent && mins <= 24 * 60 && mins > 60) {
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: appointment tomorrow - ${a.title} (${a.elder_name})`,
        text: `Hello,\n\nReminder: ${a.title}${a.doctor ? ' with ' + a.doctor : ''} for ${a.elder_name} at ${a.appt_at.replace('T', ' ')}${a.location ? ', ' + a.location : ''}.\n${a.notes || ''}\n\n- Sahaay`,
      });
      db.prepare(`UPDATE appointments SET remind_24_sent = 1 WHERE id = ?`).run(a.id);
    }
    if (!a.remind_1h_sent && mins <= 60 && mins > -30) {
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: appointment in about an hour - ${a.title} (${a.elder_name})`,
        text: `Hello,\n\n${a.title}${a.doctor ? ' with ' + a.doctor : ''} for ${a.elder_name} is at ${a.appt_at.replace('T', ' ')}${a.location ? ', ' + a.location : ''}.\n\n- Sahaay`,
      });
      db.prepare(`UPDATE appointments SET remind_1h_sent = 1 WHERE id = ?`).run(a.id);
    }
  }
}

function start(db, sendMail, intervalMs = 60000) {
  const t = setInterval(() => { tick(db, sendMail).catch(e => console.error('[reminders]', e.message)); }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { tick, start, dueRowsForToday };
