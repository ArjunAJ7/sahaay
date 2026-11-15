const { esc } = require('./util');

function layout(title, body, { simple = false, member = null } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Sahaay</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body class="${simple ? 'simple' : ''}">
<a class="skip" href="#main">Skip to main content</a>
<header>
  <div class="wrap">
    <a class="brand" href="/">Sahaay</a>
    ${member ? `<nav aria-label="Main">
      <a href="/app">Home</a><a href="/app/meds">Medicines</a><a href="/app/appointments">Appointments</a><a href="/app/members">Family</a><a href="/logout">Log out</a>
    </nav>` : ''}
  </div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="wrap"><p>Sahaay helps families coordinate care. It is not a medical device and does not give medical advice - medication schedules are set by you or your doctor.</p></footer>
</body>
</html>`;
}

function flash(msg) { return msg ? `<p class="flash" role="status">${esc(msg)}</p>` : ''; }

function landing(err) {
  return layout('Welcome', `
<h1>Care for your elders, together.</h1>
<p class="lede">One shared place for an elderly person's medicines, doses and appointments - for them, their family and their caretakers.</p>
${flash(err)}
<div class="cards">
<section class="card" aria-labelledby="create-h">
  <h2 id="create-h">Start a care profile</h2>
  <form method="post" action="/profiles">
    <label>Elderly person's name <input name="elder_name" required autocomplete="off"></label>
    <label>Your name <input name="name" required autocomplete="name"></label>
    <label>You are <select name="role"><option value="family">a family member</option><option value="caretaker">a caretaker</option><option value="elder">the elderly person</option></select></label>
    <label>Your email for reminders <input name="email" type="email" required autocomplete="email"></label>
    <label>Family passcode (4-8 digits) <input name="passcode" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required aria-describedby="pc-hint"></label>
    <p class="hint" id="pc-hint">Everyone who joins this profile uses this passcode. Share it only with family and caretakers.</p>
    <button type="submit">Create profile</button>
  </form>
</section>
<section class="card" aria-labelledby="join-h">
  <h2 id="join-h">Join a care profile</h2>
  <form method="post" action="/join">
    <label>Profile code <input name="code" required autocomplete="off" style="text-transform:uppercase"></label>
    <label>Family passcode <input name="passcode" inputmode="numeric" required></label>
    <label>Your name <input name="name" required></label>
    <label>You are <select name="role"><option value="family">a family member</option><option value="caretaker">a caretaker</option><option value="elder">the elderly person</option></select></label>
    <label>Your email for reminders <input name="email" type="email" required></label>
    <button type="submit">Join</button>
  </form>
</section>
</div>`);
}

function doseRow(d, simple) {
  const taken = d.status === 'taken';
  const missed = d.status === 'missed';
  return `<li class="dose ${d.status}">
    <div><strong class="dose-time">${esc(d.scheduled_time)}</strong>
    <span class="dose-name">${esc(d.med_name)}${d.dosage ? ' ' + esc(d.dosage) : ''}</span>
    ${d.instructions ? `<span class="hint">${esc(d.instructions)}</span>` : ''}</div>
    ${taken ? `<span class="ok">Taken${d.taken_by ? ' by ' + esc(d.taken_by) : ''}</span>`
      : missed ? `<form method="post" action="/app/doses/${d.id}/taken"><button class="btn-late">Mark as taken (late)</button></form><span class="bad">Missed - family notified</span>`
      : `<form method="post" action="/app/doses/${d.id}/taken"><button class="btn-taken">Mark dose as taken</button></form>`}
  </li>`;
}

function dashboard({ profile, member, doses, appts, adherence, activity, simple }) {
  const doseList = doses.length ? `<ul class="doses">${doses.map(d => doseRow(d, simple)).join('')}</ul>` : '<p>No medicines scheduled for today.</p>';
  const apptList = appts.length ? `<ul class="appts">${appts.map(a => `<li><strong>${esc(a.appt_at.replace('T', ' '))}</strong> - ${esc(a.title)}${a.doctor ? ' (' + esc(a.doctor) + ')' : ''}${a.location ? ', ' + esc(a.location) : ''}</li>`).join('')}</ul>` : '<p>No upcoming appointments.</p>';
  const acts = activity.map(a => `<li>${esc(a.at)} - ${esc(a.actor)} ${esc(a.action)}</li>`).join('');
  return layout(`${profile.elder_name} - Home`, `
<h1>Hello ${esc(member.name)}</h1>
<p class="lede">This is <strong>${esc(profile.elder_name)}</strong>'s care profile. Profile code: <strong class="code">${esc(profile.code)}</strong></p>
<section aria-labelledby="today-h">
  <h2 id="today-h">Today's medicines</h2>
  <p class="hint">Adherence this week: ${adherence.taken}/${adherence.total} doses taken.</p>
  ${doseList}
</section>
<section aria-labelledby="appt-h">
  <h2 id="appt-h">Upcoming appointments</h2>
  ${apptList}
</section>
${simple ? '' : `<section aria-labelledby="act-h"><h2 id="act-h">Family activity</h2><ul class="activity">${acts || '<li>Nothing yet.</li>'}</ul></section>`}
`, { simple, member });
}

function medsPage({ profile, member, meds, parsed, quick, err }) {
  const rows = meds.map(m => `<li class="${m.active ? '' : 'inactive'}">
    <strong>${esc(m.name)}</strong> ${esc(m.dosage || '')} - ${JSON.parse(m.times).map(esc).join(', ')}${m.instructions ? ' - ' + esc(m.instructions) : ''}
    ${m.end_date ? `until ${esc(m.end_date)}` : 'ongoing'}
    ${m.active ? `<a class="btn-small" href="/app/meds/${m.id}/archive">Archive</a>` : '(archived)'}
  </li>`).join('');
  let addForm;
  if (parsed) {
    addForm = `<section class="card" aria-labelledby="confirm-h"><h2 id="confirm-h">Confirm this medicine</h2>
    <p>Please check every detail. Sahaay only saves what you confirm here - nothing is guessed.</p>
    <form method="post" action="/app/meds">
      <input type="hidden" name="confirmed" value="1">
      <label>Medicine name <input name="name" required value="${esc(parsed.name || '')}"></label>
      <label>Strength / dose (as written by the doctor) <input name="dosage" value="${esc(parsed.dosage || '')}" placeholder="e.g. 500mg"></label>
      <label>Instructions <input name="instructions" value="${esc(parsed.instructions || '')}" placeholder="e.g. after food"></label>
      <fieldset><legend>Exact times of day (required - choose the actual clock times)</legend>
        ${[1, 2, 3, 4].slice(0, Math.max(parsed.dosesPerDay || 1, 1)).map((_, i) => `<label>Dose ${i + 1} <input type="time" name="time${i + 1}" required></label>`).join('')}
        ${parsed.dosesPerDay ? '' : '<p class="hint">No frequency was found in your text, so one time is shown - add more after saving if needed.</p>'}
      </fieldset>
      <label>Start date <input type="date" name="start_date" required value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>End date (leave blank if ongoing) <input type="date" name="end_date"></label>
      <button type="submit">Save medicine</button>
    </form></section>`;
  } else {
    addForm = `<section class="card" aria-labelledby="add-h"><h2 id="add-h">Add a medicine</h2>
    ${flash(err)}
    <form method="post" action="/app/meds/parse">
      <label>Describe it exactly as the doctor wrote it
        <input name="quick" value="${esc(quick || '')}" placeholder="e.g. Metformin 500mg twice daily after food" required></label>
      <p class="hint">Sahaay will pick out the name, strength and frequency you wrote. You will then confirm the exact times yourself. Never add a medicine or dose a doctor has not prescribed.</p>
      <button type="submit">Continue</button>
    </form></section>`;
  }
  return layout('Medicines', `
<h1>${esc(profile.elder_name)}'s medicines</h1>
<ul class="meds">${rows || '<li>No medicines yet.</li>'}</ul>
${addForm}`, { member });
}

module.exports = { layout, landing, dashboard, medsPage, flash };
