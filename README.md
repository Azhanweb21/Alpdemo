# SchoolOS Realtime MVP

A runnable full-stack school-management starter with a persistent SQLite database, role-based login, and Socket.IO live updates across connected browser sessions.

## Included
- Principal/admin and teacher roles
- Persistent student records
- Daily attendance and bulk save
- Classroom activities planner
- Weekly lesson plans with principal review
- Marks entry with calculated percentages and configurable-in-code starter grade bands
- Parent communication log (recording only; does not place calls or send messages)
- Teacher training modules and completion status
- Team account creation
- Dashboard cards and a live recent-activity feed

## Run locally
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set a long random `JWT_SECRET`.
3. In this folder run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

First-run demo accounts:
- Principal: `principal@demo.school` / `Admin@123`
- Teacher: `saba@demo.school` / `Teacher@123`
- Teacher: `ali@demo.school` / `Teacher@123`

Change or remove demo credentials before any real deployment. The SQLite database file (`schoolos.sqlite`) is created automatically in this folder. Do not commit it or share it publicly if it contains real student data.

## What “real-time” means here
Writes to the API are saved to the database and a Socket.IO event is broadcast to connected browsers. Other open sessions refresh the affected section/dashboard without a manual page refresh. It is real-time between clients connected to this same running server. This is not yet a multi-region or multi-instance production deployment.

## Important production work still required
This is a working MVP foundation, not a certified production school platform. Before entering real student/guardian data or putting it on the public internet:
- Deploy behind HTTPS on a managed host; set a strong secret and disable/remove demo accounts.
- Move from SQLite to managed PostgreSQL for multi-instance deployment; use migrations, automated backups, and restore tests.
- Add school-specific permission policies, audit history, account recovery, rate limiting, CSRF/origin protections, monitoring, and a data retention policy.
- Configure secure file storage and virus/type/size checks for lecture audio, screenshots, worksheets and training media. File upload is not implemented in this starter.
- Connect a real calling/SMS/WhatsApp provider and approved AI voice service before sending anything to guardians. Current communications are log entries only; no calls or messages are sent.
- Confirm guardian consent, local privacy requirements, approved school scripts, escalation rules, and human review for AI interactions.
- Confirm the school's grading rules, class structure, attendance statuses, timezone, terms, and data import process.

## Realtime architecture
Browser UI → Express API (JWT role checks) → SQLite database → Socket.IO broadcast → connected browser clients.

For public deployment with multiple server instances, use PostgreSQL plus a Socket.IO-compatible shared adapter/pub-sub layer (or the selected hosted realtime service), not local SQLite as shared storage.
