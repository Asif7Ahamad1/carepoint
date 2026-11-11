import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = await readFile(path.join(root, "database", "schema.sql"), "utf8");
const seed = await readFile(path.join(root, "database", "seed.sql"), "utf8");

const appAccount = `

-- Create a least-privilege app account.
-- Use Workbench Find/Replace All on the password placeholder below to set both
-- statements to the same new password. Also update packages/api/.env.
CREATE USER IF NOT EXISTS 'carepoint_app'@'127.0.0.1'
  IDENTIFIED BY 'CHANGE_THIS_PASSWORD';
ALTER USER 'carepoint_app'@'127.0.0.1'
  IDENTIFIED BY 'CHANGE_THIS_PASSWORD';

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

-- Verify the import. Expected appointment_rows: 3000.
SELECT COUNT(*) AS appointment_rows FROM carepoint_booking.appointments;
`;

const output = path.join(root, "database", "workbench-setup.sql");
await writeFile(output, `${schema.trimEnd()}\n\n${seed.trim()}\n${appAccount.trim()}\n`, "utf8");
console.log("Wrote database/workbench-setup.sql (schema, 3,000 sample appointments, app user, and grants).");
