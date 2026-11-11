# CarePoint — clinic appointments, without the guesswork

CarePoint is a full-stack clinic booking demo with generated appointment availability, concurrent-booking protection, a live token queue, waitlist offers, and an appointment audit log.

## Run locally

Requirements: Node.js 20.19+ and npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173`. The API is at `http://localhost:4000/api`. Without MySQL configured, the API runs in demo mode with fictional doctors and a live sample queue.

```powershell
npm.cmd run build
npm.cmd test
```

With the dev server running, run the HTTP-level concurrency harness in a second terminal:

```powershell
npm.cmd run test:concurrency
```

The harness races two booking requests for the same slot, checks that the winner cannot book an overlapping time with another doctor, then cancels its temporary appointment.

## MySQL Workbench setup and the 3,000-row dataset

Use a **MySQL 8.0.16+ server**. MySQL Workbench is the client; it must connect to a running MySQL server.

### 1. Create the database tables in Workbench

Connect in Workbench using your MySQL administrator account (often `root`). Choose **File → Open SQL Script**, open:

`database/schema.sql`

Press the lightning-bolt **Execute** button to run the script. It creates and selects the new `carepoint_booking` database, tables, indexes, and immutable-audit triggers. The old `carepoint` database is left untouched.

### 2. Load the sample records

Open `database/seed.sql` with **File → Open SQL Script**, then press **Execute**. It contains exactly **3,000 fictional appointments**, 3,000 sample patient profiles plus the demo patient, and the doctor, availability, metrics, and audit seed data. Execute the full schema first so the tables exist. Verify:

```sql
SELECT COUNT(*) AS appointment_rows FROM carepoint_booking.appointments;
```

The result should be `3000`. To regenerate the dataset from the included generator, run `npm.cmd run seed:sql`.

### 3. Create a separate application account

Open a **new SQL Editor tab connected as `root`** and execute this. Use the same new password in both places shown below. This is the app account password, **not your root password**:

```sql
CREATE USER IF NOT EXISTS 'carepoint_app'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_A_PRIVATE_PASSWORD';
ALTER USER 'carepoint_app'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_A_PRIVATE_PASSWORD';

GRANT SELECT ON carepoint_booking.doctors TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT ON carepoint_booking.patients TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT ON carepoint_booking.users TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT, DELETE ON carepoint_booking.auth_sessions TO 'carepoint_app'@'127.0.0.1';
GRANT INSERT ON carepoint_booking.doctor_applications TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT ON carepoint_booking.availability_rules TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT ON carepoint_booking.doctor_leave TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON carepoint_booking.appointment_slots TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON carepoint_booking.appointments TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON carepoint_booking.doctor_daily_counters TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON carepoint_booking.doctor_metrics TO 'carepoint_app'@'127.0.0.1';
GRANT SELECT, INSERT ON carepoint_booking.appointment_audit_log TO 'carepoint_app'@'127.0.0.1';
```

Replace **both** occurrences of `REPLACE_WITH_A_PRIVATE_PASSWORD` with the same new password, then execute the SQL. If your server already has this account, `ALTER USER` resets its password.

### 4. Put the app password in the project-root `.env`

Create a file named `.env` **in the top-level project folder, alongside `package.json`**. Copy `.env.example`, then set:

```dotenv
DATABASE_URL=mysql://carepoint_app:YOUR_APP_PASSWORD@127.0.0.1:3306/carepoint_booking
CLINIC_TIME_ZONE=Asia/Kolkata
```

Replace `YOUR_APP_PASSWORD` with the same password used in the SQL above. Do not put SQL commands or a MySQL password in `schema.sql`, TypeScript files, or frontend files. `.env` is ignored by Git. The API loads the root `.env` first; it also accepts the existing `packages/api/.env` as a fallback.

If the password contains reserved URL characters (such as `@`, `:`, `/`, or `#`), URL-encode them or use an alphanumeric app password. This example is for a MySQL server on this computer; for a remote server, update both the MySQL account's allowed host and the connection URL.

Restart `npm.cmd run dev` after saving `.env`. Verify `http://localhost:4000/api/health`; its mode should say `mysql`. If `DATABASE_URL` is blank, the app uses demo mode. If MySQL is configured but cannot be reached, the API reports an error instead of silently switching to demo mode.

The CLI alternative requires the MySQL command-line client:

```powershell
& $env:ComSpec /c 'mysql -u root -p < database\schema.sql'
& $env:ComSpec /c 'mysql -u root -p carepoint_booking < database\seed.sql'
```

## How booking races are handled

The app does not lock a not-yet-created appointment row. Availability lookup generates slots from each doctor's rules and writes those candidate keys to `appointment_slots`. A transaction locks the already-existing `(doctor_id, starts_at)` row with `SELECT ... FOR UPDATE`, then checks for an active appointment before inserting. A database unique constraint is a final guard against duplicate active bookings.

The transaction also locks the pre-existing patient record before checking the patient's other active appointment intervals. Requests by the same patient therefore serialize even if they target different doctors. The interval check catches overlapping appointments with different start times; a unique key protects the exact-start case.

## Sign-in and registration

The public website opens in demo mode. Use **Sign in** in the top bar, then **Create account** to register a patient or submit a doctor application. Patient accounts and their patient profiles are saved in MySQL. Passwords are stored as salted scrypt hashes, and sign-in sessions expire after seven days.

Doctor registrations are stored as pending applications with specialty, experience, fee, introduction, and medical registration number. They are intentionally not listed or granted doctor tools until the clinic verifies them. This project has no clinic administrator approval screen yet; approval must be handled by the clinic operator in the database. The demo-role selector is only for previewing screens and is not authentication.

On an existing database, run `database/migrations/001_accounts_and_sessions.sql` in the selected CarePoint database before using account registration. New installations include the same tables in `database/schema.sql`. The app database user needs the additional `users`, `auth_sessions`, and `doctor_applications` grants shown above.

## Features

- Weekday availability generated from 10:00–14:00 and 17:00–20:00 rules, using 20-minute consultations. Doctor leave and already-booked times are excluded.
- UTC storage with clinic-local slot generation and IANA timezone display (`Asia/Kolkata` by default).
- Patient sign-in and registration persisted to MySQL; doctor applications are held for clinic review.
- Patient, doctor, and clinic-team demo screens.
- Server-sent events for live queue updates and a wait estimate based on each doctor's rolling consultation average.
- Cancellation waitlist with a 10-minute offer and automatic advancement after expiry.
- Appointment state-transition audit records; MySQL triggers reject audit-row updates and deletes.

The role selector is a **demo UI only**, not authentication or authorization. Login and registration provide basic account persistence, password hashing, and expiring sessions, but this classroom project is not a production medical-record system and does not implement a clinic administrator portal, full authorization for every existing demo operation, payment processing, or clinical records.

## Host the frontend on GitHub Pages

GitHub Pages hosts the static frontend, not the Express API or MySQL database. The Pages workflow is `.github/workflows/deploy-pages.yml`; the API can run as a Docker service on Railway with `Dockerfile` and `railway.toml`.

1. Create a **public** GitHub repository named `carepoint` under your account. The application source and fictional seed data will be public. Never commit `.env` files or a Workbench SQL file containing an actual password.
2. Push this project to the repository's `main` branch.
3. For the complete live app, deploy the API and a MySQL service on Railway. Set the API service variables `DATABASE_URL`, `CLINIC_TIME_ZONE=Asia/Kolkata`, and `WEB_ORIGIN=https://asif7ahamad1.github.io`. Initialize and seed the Railway database separately using Workbench against the database's secure external connection; don't assume the local MySQL database is internet-accessible.
4. Once the Railway API health endpoint returns `"mode":"mysql"`, add the GitHub Actions repository variable `VITE_API_BASE` containing the Railway API's HTTPS origin, without `/api`.
5. In GitHub repository settings, enable **Pages → Build and deployment → GitHub Actions**. The workflow tests the API and builds the frontend for `/carepoint/`. The public site URL is `https://asif7ahamad1.github.io/carepoint/`.

The Pages workflow deliberately fails unless `VITE_API_BASE` is configured. Without the separately hosted API and database, GitHub Pages cannot persist bookings or run the live queue. This workspace has no Git CLI installed, so creating the GitHub repository and pushing the code still needs Git installed/authenticated on your computer.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | API health, storage mode, and clinic timezone |
| `POST` | `/api/auth/register` | Create a patient account or pending doctor application |
| `POST` | `/api/auth/login` | Sign in and create a seven-day session |
| `GET` | `/api/auth/me` | Read the signed-in account |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/doctors` | Doctor directory |
| `GET` | `/api/availability?doctorId=…&date=YYYY-MM-DD` | Generated appointment slots |
| `GET` | `/api/appointments?patientId=…` | Patient appointments |
| `POST` | `/api/appointments` | Book a slot |
| `POST` | `/api/waitlist` | Join a full slot's waitlist |
| `POST` | `/api/appointments/:id/cancel` | Cancel and offer the slot to the next patient |
| `POST` | `/api/waitlist/:id/accept` | Accept a live offer |
| `POST` | `/api/appointments/:id/check-in` | Check in |
| `GET` | `/api/doctors/:doctorId/queue?patientId=…` | Queue and wait estimate |
| `GET` | `/api/doctors/:doctorId/queue/stream` | Live queue events via SSE |
| `POST` | `/api/doctors/:doctorId/queue/complete-next` | Mark the current patient seen and advance the queue |
