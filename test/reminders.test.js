const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
const db = require('../src/db');
const reminders = require('../src/reminders');

function seed() {
  const salt = 's'; const crypto = require('crypto');
  const pid = db.prepare('INSERT INTO profiles (code, elder_name, passcode_hash, salt) VALUES (?,?,?,?)')
    .run('T' + Date.now() + Math.floor(Math.random()*1e6), 'Demo Amma', 'x', salt).lastInsertRowid;
  db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)').run(pid, 'Elder', 'elder', 'elder@example.com');
  db.prepare('INSERT INTO members (profile_id, name, role, email) VALUES (?,?,?,?)').run(pid, 'Carer', 'caretaker', 'carer@example.com');
  return pid;
}

test('upcoming dose emails everyone once, missed escalates to carers once', async () => {
  const pid = seed();
  const today = new Date();
  const hh = String(today.getHours()).padStart(2, '0');
  const mm = String(today.getMinutes()).padStart(2, '0');
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  db.prepare('INSERT INTO medications (profile_id, name, dosage, times, start_date) VALUES (?,?,?,?,?)')
    .run(pid, 'TestMed', '10mg', JSON.stringify([`${hh}:${mm}`]), dateStr);

  const sent = [];
  const fakeSend = async (m) => { sent.push(m); return { sent: true }; };

  await reminders.tick(db, fakeSend, today);
  assert.strictEqual(sent.length, 1, 'one upcoming reminder');
  assert.deepStrictEqual(sent[0].to.sort(), ['carer@example.com', 'elder@example.com']);
  assert.ok(sent[0].subject.includes('TestMed'));

  // Second tick at same time: no duplicate
  await reminders.tick(db, fakeSend, today);
  assert.strictEqual(sent.length, 1, 'no duplicate upcoming reminder');

  // 31 minutes later: missed escalation to caretakers/family only, marked missed
  const later = new Date(today.getTime() + 31 * 60000);
  await reminders.tick(db, fakeSend, later);
  assert.strictEqual(sent.length, 2, 'one missed escalation');
  assert.deepStrictEqual(sent[1].to, ['carer@example.com']);
  assert.ok(sent[1].subject.includes('MISSED'));
  const row = db.prepare('SELECT status, missed_sent FROM dose_log').get();
  assert.strictEqual(row.status, 'missed');
  assert.strictEqual(row.missed_sent, 1);

  // And no further escalation
  await reminders.tick(db, fakeSend, new Date(today.getTime() + 62 * 60000));
  assert.strictEqual(sent.length, 2, 'no duplicate missed escalation');
});

test('taken dose never escalates', async () => {
  const pid = seed();
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const mid = db.prepare('INSERT INTO medications (profile_id, name, times, start_date) VALUES (?,?,?,?)')
    .run(pid, 'TakenMed', JSON.stringify([hhmm]), dateStr).lastInsertRowid;
  reminders.dueRowsForToday(db, now);
  db.prepare(`UPDATE dose_log SET status='taken', taken_at=datetime('now','localtime') WHERE medication_id=?`).run(mid);
  const sent = [];
  await reminders.tick(db, () => { sent.push(1); return { sent: true }; }, new Date(now.getTime() + 45 * 60000));
  assert.strictEqual(sent.length, 0, 'no emails for taken dose');
});
