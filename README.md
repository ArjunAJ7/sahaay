# Sahaay - Elderly Care & Medication Management Platform

**PromptWars x Catalyst submission (solo).** Sahaay is a shared, passcode-secured
care platform that helps elderly people manage daily medications and medical
appointments while keeping family members and caretakers informed - with the
elderly person at the centre of their own healthcare decisions.

## Why

The most-downloaded medication reminder apps were built for young single users:
peer-reviewed evaluations found small touch targets, confusing navigation and no
clear home screen for older adults, with caregiver features bolted on
afterwards. The best-known free *family-shared* medication app (CareZone) shut
down in 2024, leaving families without a working shared option. Sahaay is built
elderly-first and family-shared from the start.

## Features

- **Shared care profile** - one profile per elderly person; family members and
  caretakers join with a profile code + family passcode (scrypt-hashed, constant-time
  verified). Roles: elder, caretaker, family.
- **Medication schedules** - anyone authorized can add/edit medicines. Quick-add
  parses only what was *explicitly written* (name, strength, frequency) and then
  requires the exact clock times to be confirmed by a human. Sahaay never infers
  a dose, frequency or time, and gives no medical advice.
- **One-tap dose confirmation** - today's doses on one Home screen with very
  large "Taken" buttons; family sees status in real time.
- **Proactive email reminders** (Resend API):
  - upcoming-dose reminder to everyone 10 minutes before each scheduled dose;
  - **missed-dose escalation** to caretakers/family 30 minutes after a dose is
    not marked taken;
  - appointment reminders 24 hours and 1 hour before.
- **Appointments** with doctor, location and notes.
- **Family activity feed** - full transparency: who added a medicine, who marked
  a dose, who joined.
- **Weekly adherence summary** on the Home screen.
- **Simple mode** - members with the "elder" role automatically get an
  extra-large, calmer interface (also available via `?simple=1`).

## Accessibility (an explicit judging criterion)

- Single clear Home screen; minimal navigation; base font 19-24px; large
  high-contrast controls (min 56px targets, 56px+ in simple mode).
- Semantic landmarks, labelled controls, visible focus rings, skip link.
- Works fully without JavaScript (plain HTML forms).

## Tech

- Node 22 + Express, server-rendered HTML (no build step).
- SQLite via `node:sqlite` (zero native dependencies).
- Reminder engine: in-process scheduler (Cloud Run min-instance deployment).
- Email: Resend (set `RESEND_API_KEY`; without it the mailer logs and no-ops).
- Tests: `npm test` (parser safety contract + reminder engine behaviour,
  including no-duplicate and no-escalation-after-taken guarantees).

## Run locally

```bash
npm install
npm start          # http://localhost:8080
npm test
```

## Deploy to Cloud Run

```bash
gcloud run deploy sahaay --source . --region asia-south1 \
  --allow-unauthenticated --min-instances 1 \
  --set-env-vars RESEND_API_KEY=<key>
```

`min-instances 1` keeps the reminder scheduler alive.

## Safety & privacy

- Not a medical device; no medical advice. Schedules come from the family or
  the doctor, never from the app.
- Passcodes hashed with scrypt; sessions are opaque HttpOnly cookies.
- Security headers set; input validated server-side; output escaped.
- The seeded demo profile uses fictional data only.

## License

MIT - see [LICENSE](LICENSE).
