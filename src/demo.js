// Demo profile: synthetic, clearly-labeled data so visitors (and judges) can
// explore Sahaay without creating anything. Fictional person, no real data.
const { hashPasscode, newSalt, todayStr } = require('./util');

function ensureDemo(db) {
  let p = db.prepare('SELECT * FROM profiles WHERE code = ?').get('DEMO26');
  if (p) return p;
  const salt = newSalt();
  const pid = db.prepare('INSERT INTO profiles (code, elder_name, passcode_hash, salt, notes) VALUES (?,?,?,?,?)')
    .run('DEMO26', 'Demo Amma (fictional)', hashPasscode('1234', salt), salt,
      'Synthetic demo profile. All people, medicines and appointments here are fictional.').lastInsertRowid;
  db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)').run(pid, 'Demo Daughter (fictional)', 'family', 'demo@example.com');
  db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)').run(pid, 'Demo Amma (fictional)', 'elder', 'demo-elder@example.com');
  const today = todayStr();
  const mk = (name, dosage, instructions, times) =>
    db.prepare('INSERT INTO medications (profile_id, name, dosage, instructions, times, start_date, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(pid, name, dosage, instructions, JSON.stringify(times), today, 'Demo Daughter (fictional)').lastInsertRowid;
  const m1 = mk('Metformin', '500mg', 'after food', ['08:00', '20:00']);
  mk('Vitamin D3', '1000 IU', '', ['09:00']);
  mk('Amlodipine', '5mg', '', ['08:00']);
  db.prepare(`INSERT INTO dose_log (medication_id, scheduled_date, scheduled_time, status, taken_at, taken_by)
              VALUES (?,?,?,'taken', datetime('now','localtime','-3 hours'), 'Demo Amma (fictional)')`)
    .run(m1, today, '08:00');
  db.prepare('INSERT INTO appointments (profile_id, title, doctor, location, appt_at, notes) VALUES (?,?,?,?,?,?)')
    .run(pid, 'Cardiology check-up', 'Dr. Rao (fictional)', 'City Clinic, Kozhikode', `${today}T17:30`, 'Bring previous reports (demo).');
  db.prepare('INSERT INTO activity (profile_id, actor, action) VALUES (?,?,?)').run(pid, 'Demo Daughter (fictional)', 'added medicine Metformin (08:00, 20:00)');
  db.prepare('INSERT INTO activity (profile_id, actor, action) VALUES (?,?,?)').run(pid, 'Demo Amma (fictional)', 'marked Metformin (08:00) as taken');
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(pid);
}

module.exports = { ensureDemo };
