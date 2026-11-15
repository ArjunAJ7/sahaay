// Demo profile: synthetic, clearly-labeled data so visitors (and judges) can
// explore Sahaay without creating anything. Fictional person, no real data.
const { hashPasscode, newSalt, todayStr } = require('./util');

async function ensureDemo(store) {
  let p = await store.getProfileByCode('DEMO26');
  if (p) return p;
  const salt = newSalt();
  p = await store.createProfile({
    code: 'DEMO26', elder_name: 'Demo Amma (fictional)',
    passcode_hash: hashPasscode('1234', salt), salt,
    notes: 'Synthetic demo profile. All people, medicines and appointments here are fictional.',
  });
  const pid = p.id;
  await store.addMember({ profile_id: pid, name: 'Demo Daughter (fictional)', role: 'family', email: 'demo@example.com' });
  await store.addMember({ profile_id: pid, name: 'Demo Amma (fictional)', role: 'elder', email: 'demo-elder@example.com' });
  const today = todayStr();
  const mk = (name, dosage, instructions, times) =>
    store.addMedication({ profile_id: pid, name, dosage, instructions, times, start_date: today, created_by: 'Demo Daughter (fictional)' });
  const m1 = await mk('Metformin', '500mg', 'after food', ['08:00', '20:00']);
  await mk('Vitamin D3', '1000 IU', '', ['09:00']);
  await mk('Amlodipine', '5mg', '', ['08:00']);
  await store.insertTakenDoseAgo(m1.id, today, '08:00', 'Demo Amma (fictional)', 3);
  await store.addAppointment({
    profile_id: pid, title: 'Cardiology check-up', doctor: 'Dr. Rao (fictional)',
    location: 'City Clinic, Kozhikode', appt_at: `${today}T17:30`, notes: 'Bring previous reports (demo).',
  });
  await store.addActivity(pid, 'Demo Daughter (fictional)', 'added medicine Metformin (08:00, 20:00)');
  await store.addActivity(pid, 'Demo Amma (fictional)', 'marked Metformin (08:00) as taken');
  return store.getProfileById(pid);
}

module.exports = { ensureDemo };
