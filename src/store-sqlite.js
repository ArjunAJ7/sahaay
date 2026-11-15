// SQLite implementation of the Sahaay data store (async facade over node:sqlite).
const db = require('./db');
const { todayStr } = require('./util');

const store = {
  kind: 'sqlite',
  async createProfile({ code, elder_name, passcode_hash, salt, notes = '' }) {
    const info = db.prepare('INSERT INTO profiles (code, elder_name, passcode_hash, salt, notes) VALUES (?,?,?,?,?)')
      .run(code, elder_name, passcode_hash, salt, notes);
    return this.getProfileById(Number(info.lastInsertRowid));
  },
  async getProfileById(id) { return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id); },
  async getProfileByCode(code) { return db.prepare('SELECT * FROM profiles WHERE code = ?').get(code); },
  async addMember({ profile_id, name, role, email }) {
    const info = db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)').run(profile_id, name, role, email);
    return db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
  },
  async listMembers(profileId) { return db.prepare('SELECT * FROM members WHERE profile_id = ? ORDER BY id').all(profileId); },
  async membersByRoles(profileId, roles) {
    const ph = roles.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM members WHERE profile_id = ? AND role IN (${ph})`).all(profileId, ...roles);
  },
  async firstFamilyMember(profileId) {
    return db.prepare("SELECT * FROM members WHERE profile_id = ? AND role = 'family' ORDER BY id LIMIT 1").get(profileId);
  },
  async createSession(token, memberId) { db.prepare('INSERT INTO sessions (token, member_id) VALUES (?,?)').run(token, memberId); },
  async getSessionMember(tok) {
    return db.prepare(`SELECT m.*, p.elder_name, p.code, p.id AS pid FROM sessions s
      JOIN members m ON m.id = s.member_id JOIN profiles p ON p.id = m.profile_id WHERE s.token = ?`).get(tok);
  },
  async deleteSession(tok) { db.prepare('DELETE FROM sessions WHERE token = ?').run(tok); },
  async addMedication(m) {
    const info = db.prepare('INSERT INTO medications (profile_id, name, dosage, instructions, times, start_date, end_date, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(m.profile_id, m.name, m.dosage, m.instructions, JSON.stringify(m.times), m.start_date, m.end_date || null, m.created_by);
    return db.prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
  },
  async listMedications(profileId) { return db.prepare('SELECT * FROM medications WHERE profile_id = ? ORDER BY active DESC, name').all(profileId); },
  async getMedication(id) { return db.prepare('SELECT * FROM medications WHERE id = ?').get(id); },
  async stopMedication(id) { db.prepare('UPDATE medications SET active = 0 WHERE id = ?').run(id); },
  async activeMedsForDate(dateStr) {
    return db.prepare(`SELECT m.*, p.elder_name, p.code AS profile_code FROM medications m JOIN profiles p ON p.id = m.profile_id
      WHERE m.active = 1 AND m.start_date <= ? AND (m.end_date IS NULL OR m.end_date >= ?)`).all(dateStr, dateStr);
  },
  async ensureDose(medicationId, dateStr, time) {
    db.prepare('INSERT OR IGNORE INTO dose_log (medication_id, scheduled_date, scheduled_time) VALUES (?,?,?)').run(medicationId, dateStr, time);
  },
  async dosesForProfileDate(profileId, dateStr) {
    return db.prepare(`SELECT d.*, mt.name AS med_name, mt.dosage, mt.instructions FROM dose_log d
      JOIN medications mt ON mt.id = d.medication_id WHERE mt.profile_id = ? AND d.scheduled_date = ? ORDER BY d.scheduled_time`).all(profileId, dateStr);
  },
  async getDose(id) {
    return db.prepare(`SELECT d.*, mt.profile_id, mt.name AS med_name FROM dose_log d JOIN medications mt ON mt.id = d.medication_id WHERE d.id = ?`).get(id);
  },
  async markDoseTaken(id, byName) {
    db.prepare(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime'), taken_by=? WHERE id=?`).run(byName, id);
  },
  async pendingDoses(dateStr) {
    return db.prepare(`SELECT d.*, m.name AS med_name, m.dosage, m.instructions, m.profile_id, p.elder_name
      FROM dose_log d JOIN medications m ON m.id = d.medication_id JOIN profiles p ON p.id = m.profile_id
      WHERE d.scheduled_date = ? AND d.status = 'pending'`).all(dateStr);
  },
  async markReminderSent(id) { db.prepare('UPDATE dose_log SET reminder_sent = 1 WHERE id = ?').run(id); },
  async markMissedSent(id) { db.prepare(`UPDATE dose_log SET missed_sent = 1, status = 'missed' WHERE id = ? AND status = 'pending'`).run(id); },
  async markDoseTakenIfPending(id, byName) {
    db.prepare(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime'), taken_by=? WHERE id=? AND status != 'taken'`).run(byName, id);
  },
  async addAppointment(a) {
    db.prepare('INSERT INTO appointments (profile_id, title, doctor, location, appt_at, notes) VALUES (?,?,?,?,?,?)')
      .run(a.profile_id, a.title, a.doctor, a.location, a.appt_at, a.notes);
  },
  async listAppointments(profileId, limit = 30) { return db.prepare('SELECT * FROM appointments WHERE profile_id = ? ORDER BY appt_at DESC LIMIT ?').all(profileId, limit); },
  async upcomingAppointments(profileId) {
    return db.prepare(`SELECT * FROM appointments WHERE profile_id = ? AND appt_at >= datetime('now','localtime','-1 hour') ORDER BY appt_at LIMIT 5`).all(profileId);
  },
  async unremindedAppointments() {
    return db.prepare(`SELECT a.*, p.elder_name FROM appointments a JOIN profiles p ON p.id = a.profile_id WHERE (a.remind_24_sent = 0 OR a.remind_1h_sent = 0)`).all();
  },
  async markAppt24(id) { db.prepare('UPDATE appointments SET remind_24_sent = 1 WHERE id = ?').run(id); },
  async markAppt1h(id) { db.prepare('UPDATE appointments SET remind_1h_sent = 1 WHERE id = ?').run(id); },
  async addActivity(profileId, actor, action) { db.prepare('INSERT INTO activity (profile_id, actor, action) VALUES (?,?,?)').run(profileId, actor, action); },
  async listActivity(profileId, limit = 8) { return db.prepare('SELECT * FROM activity WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(profileId, limit); },
  async adherenceWeek(profileId) {
    const wk = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='taken' THEN 1 ELSE 0 END) AS taken
      FROM dose_log d JOIN medications mt ON mt.id = d.medication_id
      WHERE mt.profile_id = ? AND d.scheduled_date >= date('now','localtime','-6 days')`).get(profileId);
    return { taken: wk.taken || 0, total: wk.total || 0 };
  },
};
module.exports = store;
