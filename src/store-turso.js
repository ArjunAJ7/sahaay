// Turso (libsql) implementation of the Sahaay data store.
// Same async API as store-sqlite.js; SQL is sqlite dialect, which libsql speaks.
const { createClient } = require('@libsql/client');

function init() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required for STORE=turso');
  const db = createClient({ url, authToken });
  const q = async (sql, args = []) => db.execute({ sql, args });

  return {
    kind: 'turso',
    async createProfile({ code, elder_name, passcode_hash, salt, notes = '' }) {
      const r = await q('INSERT INTO profiles (code, elder_name, passcode_hash, salt, notes) VALUES (?,?,?,?,?)',
        [code, elder_name, passcode_hash, salt, notes]);
      return this.getProfileById(Number(r.lastInsertRowid));
    },
    async getProfileById(id) { return (await q('SELECT * FROM profiles WHERE id = ?', [id])).rows[0]; },
    async getProfileByCode(code) { return (await q('SELECT * FROM profiles WHERE code = ?', [code])).rows[0]; },
    async addMember({ profile_id, name, role, email }) {
      const r = await q('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)', [profile_id, name, role, email]);
      return (await q('SELECT * FROM members WHERE id = ?', [r.lastInsertRowid])).rows[0];
    },
    async listMembers(profileId) { return (await q('SELECT * FROM members WHERE profile_id = ? ORDER BY id', [profileId])).rows; },
    async membersByRoles(profileId, roles) {
      const ph = roles.map(() => '?').join(',');
      return (await q(`SELECT * FROM members WHERE profile_id = ? AND role IN (${ph})`, [profileId, ...roles])).rows;
    },
    async firstFamilyMember(profileId) {
      return (await q("SELECT * FROM members WHERE profile_id = ? AND role = 'family' ORDER BY id LIMIT 1", [profileId])).rows[0];
    },
    async createSession(token, memberId) { await q('INSERT INTO sessions (token, member_id) VALUES (?,?)', [token, memberId]); },
    async getSessionMember(tok) {
      return (await q(`SELECT m.*, p.elder_name, p.code, p.id AS pid FROM sessions s
        JOIN members m ON m.id = s.member_id JOIN profiles p ON p.id = m.profile_id WHERE s.token = ?`, [tok])).rows[0];
    },
    async deleteSession(tok) { await q('DELETE FROM sessions WHERE token = ?', [tok]); },
    async addMedication(m) {
      const r = await q('INSERT INTO medications (profile_id, name, dosage, instructions, times, start_date, end_date, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [m.profile_id, m.name, m.dosage, m.instructions, JSON.stringify(m.times), m.start_date, m.end_date || null, m.created_by]);
      return (await q('SELECT * FROM medications WHERE id = ?', [r.lastInsertRowid])).rows[0];
    },
    async listMedications(profileId) { return (await q('SELECT * FROM medications WHERE profile_id = ? ORDER BY active DESC, name', [profileId])).rows; },
    async getMedication(id) { return (await q('SELECT * FROM medications WHERE id = ?', [id])).rows[0]; },
    async stopMedication(id) { await q('UPDATE medications SET active = 0 WHERE id = ?', [id]); },
    async activeMedsForDate(dateStr) {
      return (await q(`SELECT m.*, p.elder_name, p.code AS profile_code FROM medications m JOIN profiles p ON p.id = m.profile_id
        WHERE m.active = 1 AND m.start_date <= ? AND (m.end_date IS NULL OR m.end_date >= ?)`, [dateStr, dateStr])).rows;
    },
    async ensureDose(medicationId, dateStr, time) {
      await q('INSERT OR IGNORE INTO dose_log (medication_id, scheduled_date, scheduled_time) VALUES (?,?,?)', [medicationId, dateStr, time]);
    },
    async dosesForProfileDate(profileId, dateStr) {
      return (await q(`SELECT d.*, mt.name AS med_name, mt.dosage, mt.instructions FROM dose_log d
        JOIN medications mt ON mt.id = d.medication_id WHERE mt.profile_id = ? AND d.scheduled_date = ? ORDER BY d.scheduled_time`, [profileId, dateStr])).rows;
    },
    async getDose(id) {
      return (await q(`SELECT d.*, mt.profile_id, mt.name AS med_name FROM dose_log d JOIN medications mt ON mt.id = d.medication_id WHERE d.id = ?`, [id])).rows[0];
    },
    async markDoseTaken(id, byName) {
      await q(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime'), taken_by=? WHERE id=?`, [byName, id]);
    },
    async pendingDoses(dateStr) {
      return (await q(`SELECT d.*, m.name AS med_name, m.dosage, m.instructions, m.profile_id, p.elder_name
        FROM dose_log d JOIN medications m ON m.id = d.medication_id JOIN profiles p ON p.id = m.profile_id
        WHERE d.scheduled_date = ? AND d.status = 'pending'`, [dateStr])).rows;
    },
    async markReminderSent(id) { await q('UPDATE dose_log SET reminder_sent = 1 WHERE id = ?', [id]); },
    async markMissedSent(id) { await q(`UPDATE dose_log SET missed_sent = 1, status = 'missed' WHERE id = ? AND status = 'pending'`, [id]); },
    // Returns rowsAffected so callers can tell whether this call won the race.
    async markDoseTakenIfPending(id, byName) {
      const r = await q(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime'), taken_by=? WHERE id=? AND status != 'taken'`, [byName, id]);
      return r.rowsAffected;
    },
    async insertTakenDoseAgo(medicationId, dateStr, time, byName, hoursAgo) {
      await q(`INSERT INTO dose_log (medication_id, scheduled_date, scheduled_time, status, taken_at, taken_by)
               VALUES (?,?,?,'taken', datetime('now','localtime', ?), ?)`,
        [medicationId, dateStr, time, `-${hoursAgo} hours`, byName]);
    },
    async addAppointment(a) {
      await q('INSERT INTO appointments (profile_id, title, doctor, location, appt_at, notes) VALUES (?,?,?,?,?,?)',
        [a.profile_id, a.title, a.doctor, a.location, a.appt_at, a.notes]);
    },
    async listAppointments(profileId, limit = 30) { return (await q('SELECT * FROM appointments WHERE profile_id = ? ORDER BY appt_at DESC LIMIT ?', [profileId, limit])).rows; },
    async upcomingAppointments(profileId) {
      return (await q(`SELECT * FROM appointments WHERE profile_id = ? AND appt_at >= datetime('now','localtime','-1 hour') ORDER BY appt_at LIMIT 5`, [profileId])).rows;
    },
    async unremindedAppointments() {
      return (await q(`SELECT a.*, p.elder_name FROM appointments a JOIN profiles p ON p.id = a.profile_id WHERE (a.remind_24_sent = 0 OR a.remind_1h_sent = 0)`)).rows;
    },
    async markAppt24(id) { await q('UPDATE appointments SET remind_24_sent = 1 WHERE id = ?', [id]); },
    async markAppt1h(id) { await q('UPDATE appointments SET remind_1h_sent = 1 WHERE id = ?', [id]); },
    async addActivity(profileId, actor, action) { await q('INSERT INTO activity (profile_id, actor, action) VALUES (?,?,?)', [profileId, actor, action]); },
    async listActivity(profileId, limit = 8) { return (await q('SELECT * FROM activity WHERE profile_id = ? ORDER BY id DESC LIMIT ?', [profileId, limit])).rows; },
    async adherenceWeek(profileId) {
      const wk = (await q(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='taken' THEN 1 ELSE 0 END) AS taken
        FROM dose_log d JOIN medications mt ON mt.id = d.medication_id
        WHERE mt.profile_id = ? AND d.scheduled_date >= date('now','localtime','-6 days')`, [profileId])).rows[0];
      return { taken: wk.taken || 0, total: wk.total || 0 };
    },
  };
}
module.exports = init;
