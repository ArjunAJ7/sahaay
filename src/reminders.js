// Reminder engine. Runs every minute inside the service (Cloud Run min-instance
// deployment keeps it alive). For each profile it:
//  - creates today's pending dose rows for active medications,
//  - emails UPCOMING-dose reminders 10 min before the scheduled time,
//  - emails MISSED-dose escalations to caretakers/family 30 min after,
//  - emails appointment reminders 24h and 1h before.
// Every email is recorded (reminder_sent / missed_sent flags) so nothing sends twice.
// Store-agnostic: works against the async store facade (sqlite local, Turso deploy).
const { todayStr, minutesOf } = require('./util');

async function dueRowsForToday(store, now = new Date()) {
  const today = todayStr(now);
  const meds = await store.activeMedsForDate(today);
  const rows = [];
  for (const med of meds) {
    for (const t of JSON.parse(med.times)) {
      await store.ensureDose(med.id, today, t);
      rows.push({ med, t });
    }
  }
  return rows;
}

async function memberEmails(store, profileId, roles) {
  const ms = await store.membersByRoles(profileId, roles);
  return ms.map(m => ({ name: m.name, email: m.email, role: m.role }));
}

async function tick(store, sendMail, now = new Date()) {
  await dueRowsForToday(store, now);
  const today = todayStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Upcoming + missed doses
  const pending = await store.pendingDoses(today);

  for (const d of pending) {
    const schedMin = minutesOf(d.scheduled_time);
    const label = `${d.med_name}${d.dosage ? ' ' + d.dosage : ''}`;
    if (!d.reminder_sent && nowMin >= schedMin - 10 && nowMin < schedMin + 30) {
      const everyone = await memberEmails(store, d.profile_id, ['elder', 'caretaker', 'family']);
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: ${label} due at ${d.scheduled_time} for ${d.elder_name}`,
        text: `Hello,\n\n${d.elder_name}'s ${label} is due at ${d.scheduled_time} today${d.instructions ? ` (${d.instructions})` : ''}.\nPlease open Sahaay and mark it taken once done.\n\n- Sahaay\n(Reminder only - schedules are set by the family, not medical advice.)`,
      });
      await store.markReminderSent(d.id);
    }
    if (!d.missed_sent && nowMin >= schedMin + 30) {
      const carers = await memberEmails(store, d.profile_id, ['caretaker', 'family']);
      if (carers.length) {
        await sendMail({
          to: carers.map(m => m.email),
          subject: `Sahaay MISSED dose: ${label} (${d.scheduled_time}) - ${d.elder_name}`,
          text: `Hello,\n\n${d.elder_name}'s ${label} scheduled at ${d.scheduled_time} today has NOT been marked taken after 30 minutes.\nPlease check in with them.\n\n- Sahaay`,
        });
      }
      await store.markMissedSent(d.id);
    }
  }

  // Appointments
  const appts = await store.unremindedAppointments();
  for (const a of appts) {
    const at = new Date(a.appt_at);
    const mins = (at - now) / 60000;
    const everyone = await memberEmails(store, a.profile_id, ['elder', 'caretaker', 'family']);
    if (!a.remind_24_sent && mins <= 24 * 60 && mins > 60) {
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: appointment tomorrow - ${a.title} (${a.elder_name})`,
        text: `Hello,\n\nReminder: ${a.title}${a.doctor ? ' with ' + a.doctor : ''} for ${a.elder_name} at ${a.appt_at.replace('T', ' ')}${a.location ? ', ' + a.location : ''}.\n${a.notes || ''}\n\n- Sahaay`,
      });
      await store.markAppt24(a.id);
    }
    if (!a.remind_1h_sent && mins <= 60 && mins > -30) {
      await sendMail({
        to: everyone.map(m => m.email),
        subject: `Sahaay: appointment in about an hour - ${a.title} (${a.elder_name})`,
        text: `Hello,\n\n${a.title}${a.doctor ? ' with ' + a.doctor : ''} for ${a.elder_name} is at ${a.appt_at.replace('T', ' ')}${a.location ? ', ' + a.location : ''}.\n\n- Sahaay`,
      });
      await store.markAppt1h(a.id);
    }
  }
}

function start(store, sendMail, intervalMs = 60000) {
  const t = setInterval(() => { tick(store, sendMail).catch(e => console.error('[reminders]', e.message)); }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { tick, start, dueRowsForToday };
