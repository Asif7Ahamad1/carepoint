import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { clinicDateTime, clinicLocalDate, clinicWeekday, generateClinicSlots } from "./availability.js";
import {
  ACTIVE_STATUSES,
  type Account,
  ClinicError,
  CLINIC_TIME_ZONE,
  type Appointment,
  type AppointmentStatus,
  type BookAppointmentInput,
  type ClinicStore,
  type Doctor,
  type RegisterAccountInput,
  type StoredAccount,
  type QueueSnapshot,
  type Slot,
} from "./domain.js";

type DoctorRow = RowDataPacket & Doctor;
type AccountRow = RowDataPacket & {
  id: string;
  name: string;
  email: string;
  role: "patient" | "doctor";
  status: "active" | "pending";
  password_hash: string;
};
type AppointmentRow = RowDataPacket & {
  id: string;
  doctor_id: string;
  doctor_name: string;
  patient_id: string;
  patient_name: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: AppointmentStatus;
  token_number: number;
  offered_until: Date | string | null;
  created_at: Date | string;
};

function dbDateTime(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(`${value.replace(" ", "T")}Z`).toISOString();
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    patientId: row.patient_id,
    patientName: row.patient_name,
    startsAt: iso(row.starts_at)!,
    endsAt: iso(row.ends_at)!,
    status: row.status,
    tokenNumber: row.token_number,
    offeredUntil: iso(row.offered_until),
    createdAt: iso(row.created_at)!,
  };
}

const appointmentSelect = `
  SELECT a.id, a.doctor_id, d.name AS doctor_name, a.patient_id, p.name AS patient_name,
         a.starts_at, a.ends_at, a.status, a.token_number, a.offered_until, a.created_at
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN patients p ON p.id = a.patient_id
`;

export class MySqlClinicStore implements ClinicStore {
  readonly mode = "mysql" as const;
  private readonly events = new EventEmitter();

  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<MySqlClinicStore> {
    const connectionUrl = new URL(connectionString);
    if (connectionUrl.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql:// scheme.");
    const pool = mysql.createPool({
      host: connectionUrl.hostname,
      port: Number(connectionUrl.port) || 3306,
      user: decodeURIComponent(connectionUrl.username),
      password: decodeURIComponent(connectionUrl.password),
      database: decodeURIComponent(connectionUrl.pathname.replace(/^\//, "")),
      waitForConnections: true,
      connectionLimit: 10,
      timezone: "Z",
      dateStrings: false,
    });
    await pool.query("SELECT 1");
    return new MySqlClinicStore(pool);
  }

  async registerAccount(input: RegisterAccountInput): Promise<Account> {
    const status = input.role === "doctor" ? "pending" : "active";
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "INSERT INTO users (id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)",
        [input.id, input.name, input.email, input.passwordHash, input.role, status],
      );
      if (input.role === "patient") {
        await connection.execute("INSERT INTO patients (id, name) VALUES (?, ?)", [input.id, input.name]);
      } else {
        const application = input.doctorApplication;
        if (!application) throw new ClinicError("Doctor application details are required.", 400);
        await connection.execute(
          `INSERT INTO doctor_applications
             (user_id, specialty, experience, fee, about, license_number, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          [input.id, application.specialty, application.experience, application.fee,
            application.about, application.licenseNumber],
        );
      }
      await connection.commit();
      return { id: input.id, name: input.name, email: input.email, role: input.role, status };
    } catch (error) {
      await connection.rollback();
      if (this.isDuplicate(error)) throw new ClinicError("An account with this email already exists.", 409);
      throw error;
    } finally {
      connection.release();
    }
  }

  async findAccountByEmail(email: string): Promise<StoredAccount | null> {
    const [rows] = await this.pool.query<AccountRow[]>(
      "SELECT id, name, email, password_hash, role, status FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      account: {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        status: row.status,
      },
      passwordHash: row.password_hash,
    };
  }

  async createSession(accountId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.pool.execute(
      "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      [tokenHash, accountId, dbDateTime(expiresAt)],
    );
  }

  async findSession(tokenHash: string): Promise<Account | null> {
    const [rows] = await this.pool.query<AccountRow[]>(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.password_hash
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0];
    return row
      ? { id: row.id, name: row.name, email: row.email, role: row.role, status: row.status }
      : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.execute("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
  }

  async listDoctors(): Promise<Doctor[]> {
    const [rows] = await this.pool.query<DoctorRow[]>(
      `SELECT id, name, specialty, experience, rating, fee, initials, color, about
       FROM doctors ORDER BY name`,
    );
    return rows;
  }

  async getAvailability(doctorId: string, date: string): Promise<Slot[]> {
    await this.requireDoctor(doctorId);
    const [ruleRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT start_time, end_time, consultation_minutes
       FROM availability_rules WHERE doctor_id = ? AND weekday = ? ORDER BY start_time`,
      [doctorId, clinicWeekday(date)],
    );
    const slots = generateClinicSlots(date, ruleRows.map((row) => ({
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time).slice(0, 5),
      consultationMinutes: Number(row.consultation_minutes),
    })));
    if (!slots.length) return slots;
    const [[leave]] = await this.pool.query<RowDataPacket[]>(
      "SELECT id FROM doctor_leave WHERE doctor_id = ? AND leave_date = ? LIMIT 1",
      [doctorId, date],
    );
    if (leave) return [];
    await this.materializeSlots(doctorId, slots);
    const first = dbDateTime(slots[0].startsAt);
    const last = dbDateTime(slots[slots.length - 1].startsAt);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT starts_at, status, COUNT(*) AS count
       FROM appointments
       WHERE doctor_id = ? AND starts_at BETWEEN ? AND ?
         AND status IN ('BOOKED', 'OFFERED', 'CHECKED_IN', 'WAITLISTED')
       GROUP BY starts_at, status`,
      [doctorId, first, last],
    );
    const occupancy = new Map<string, { booked: boolean; waitlistCount: number }>();
    for (const row of rows) {
      const key = iso(row.starts_at)!;
      const current = occupancy.get(key) ?? { booked: false, waitlistCount: 0 };
      if (row.status === "WAITLISTED") current.waitlistCount = Number(row.count);
      else current.booked = true;
      occupancy.set(key, current);
    }
    return slots.map((slot) => ({
      ...slot,
      available: !occupancy.get(slot.startsAt)?.booked,
      waitlistCount: occupancy.get(slot.startsAt)?.waitlistCount ?? 0,
    }));
  }

  async listAppointments(patientId?: string, doctorId?: string): Promise<Appointment[]> {
    const filters: string[] = [];
    const values: string[] = [];
    if (patientId) {
      filters.push("a.patient_id = ?");
      values.push(patientId);
    }
    if (doctorId) {
      filters.push("a.doctor_id = ?");
      values.push(doctorId);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows] = await this.pool.query<AppointmentRow[]>(
      `${appointmentSelect} ${where} ORDER BY a.starts_at DESC LIMIT 100`,
      values,
    );
    return rows.map(toAppointment);
  }

  async bookAppointment(input: BookAppointmentInput): Promise<Appointment> {
    const doctor = await this.requireDoctor(input.doctorId);
    const slot = await this.validateSlot(input.doctorId, input.startsAt);
    await this.materializeSlots(doctor.id, [slot]);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockPatient(connection, input.patientId);
      await this.lockSlot(connection, doctor.id, slot.startsAt, slot.endsAt);
      const [existing] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM appointments WHERE doctor_id = ? AND starts_at = ?
         AND status IN ('BOOKED', 'OFFERED', 'CHECKED_IN') LIMIT 1 FOR UPDATE`,
        [doctor.id, dbDateTime(slot.startsAt)],
      );
      if (existing.length) {
        throw new ClinicError("That slot was just taken. Choose another time or join the waitlist.", 409);
      }
      await this.assertNoOverlap(connection, input.patientId, slot.startsAt, slot.endsAt);
      const tokenNumber = await this.nextToken(connection, doctor.id, slot.startsAt);
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at, status, token_number, created_at)
         VALUES (?, ?, ?, ?, ?, 'BOOKED', ?, UTC_TIMESTAMP(3))`,
        [id, doctor.id, input.patientId, dbDateTime(slot.startsAt), dbDateTime(slot.endsAt), tokenNumber],
      );
      await this.audit(connection, id, null, "BOOKED", input.patientId);
      await connection.commit();
      this.emitUpdate(doctor.id);
      return this.requireAppointment(id);
    } catch (error) {
      await connection.rollback();
      if (this.isDuplicate(error)) throw new ClinicError("That slot or patient time was just booked.", 409);
      throw error;
    } finally {
      connection.release();
    }
  }

  async joinWaitlist(input: BookAppointmentInput): Promise<Appointment> {
    const doctor = await this.requireDoctor(input.doctorId);
    const slot = await this.validateSlot(input.doctorId, input.startsAt);
    await this.materializeSlots(doctor.id, [slot]);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockPatient(connection, input.patientId);
      await this.lockSlot(connection, doctor.id, slot.startsAt, slot.endsAt);
      const [existing] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM appointments WHERE doctor_id = ? AND starts_at = ?
         AND status IN ('BOOKED', 'OFFERED', 'CHECKED_IN') LIMIT 1 FOR UPDATE`,
        [doctor.id, dbDateTime(slot.startsAt)],
      );
      if (!existing.length) throw new ClinicError("This slot is available now; book it instead.", 409);
      const [duplicate] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM appointments WHERE doctor_id = ? AND patient_id = ? AND starts_at = ? AND status = 'WAITLISTED' LIMIT 1",
        [doctor.id, input.patientId, dbDateTime(slot.startsAt)],
      );
      if (duplicate.length) throw new ClinicError("You're already on the waitlist for this slot.", 409);
      const tokenNumber = await this.nextToken(connection, doctor.id, slot.startsAt);
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at, status, token_number, created_at)
         VALUES (?, ?, ?, ?, ?, 'WAITLISTED', ?, UTC_TIMESTAMP(3))`,
        [id, doctor.id, input.patientId, dbDateTime(slot.startsAt), dbDateTime(slot.endsAt), tokenNumber],
      );
      await this.audit(connection, id, null, "WAITLISTED", input.patientId);
      await connection.commit();
      return this.requireAppointment(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async cancelAppointment(id: string): Promise<{ appointment: Appointment; offered: Appointment | null }> {
    const initial = await this.requireAppointment(id);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockSlot(connection, initial.doctorId, initial.startsAt, initial.endsAt);
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT status, patient_id FROM appointments WHERE id = ? FOR UPDATE",
        [id],
      );
      const current = rows[0];
      if (!current) throw new ClinicError("Appointment not found.", 404);
      if (!ACTIVE_STATUSES.includes(current.status)) throw new ClinicError("This appointment can no longer be cancelled.", 409);
      await connection.execute("UPDATE appointments SET status = 'CANCELLED' WHERE id = ?", [id]);
      await this.audit(connection, id, current.status, "CANCELLED", current.patient_id);
      const [waiting] = await connection.query<RowDataPacket[]>(
        `SELECT id, patient_id FROM appointments
         WHERE doctor_id = ? AND starts_at = ? AND status = 'WAITLISTED'
         ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
        [initial.doctorId, dbDateTime(initial.startsAt)],
      );
      let offeredId: string | null = null;
      if (waiting[0]) {
        const nextId = String(waiting[0].id);
        offeredId = nextId;
        await connection.execute(
          "UPDATE appointments SET status = 'OFFERED', offered_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE) WHERE id = ?",
          [nextId],
        );
        await this.audit(connection, nextId, "WAITLISTED", "OFFERED", String(waiting[0].patient_id));
      }
      await connection.commit();
      this.emitUpdate(initial.doctorId);
      return {
        appointment: await this.requireAppointment(id),
        offered: offeredId ? await this.requireAppointment(offeredId) : null,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async acceptOffer(id: string): Promise<Appointment> {
    const initial = await this.requireAppointment(id);
    const connection = await this.pool.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      await this.lockPatient(connection, initial.patientId);
      await this.lockSlot(connection, initial.doctorId, initial.startsAt, initial.endsAt);
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT status, offered_until FROM appointments WHERE id = ? FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (!row || row.status !== "OFFERED") throw new ClinicError("This waitlist offer is no longer active.", 409);
      if (!row.offered_until || new Date(row.offered_until).getTime() <= Date.now()) {
        await connection.execute("UPDATE appointments SET status = 'EXPIRED' WHERE id = ?", [id]);
        await this.audit(connection, id, "OFFERED", "EXPIRED", initial.patientId);
        await this.offerNextWaitlisted(connection, initial.doctorId, initial.startsAt);
        await connection.commit();
        committed = true;
        this.emitUpdate(initial.doctorId);
        throw new ClinicError("This offer has expired.", 410);
      }
      await this.assertNoOverlap(connection, initial.patientId, initial.startsAt, initial.endsAt, id);
      await connection.execute("UPDATE appointments SET status = 'BOOKED', offered_until = NULL WHERE id = ?", [id]);
      await this.audit(connection, id, "OFFERED", "BOOKED", initial.patientId);
      await connection.commit();
      committed = true;
      this.emitUpdate(initial.doctorId);
      return this.requireAppointment(id);
    } catch (error) {
      if (!committed) await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async checkIn(id: string): Promise<Appointment> {
    const appointment = await this.requireAppointment(id);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockSlot(connection, appointment.doctorId, appointment.startsAt, appointment.endsAt);
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT status, patient_id FROM appointments WHERE id = ? FOR UPDATE",
        [id],
      );
      if (!rows[0] || rows[0].status !== "BOOKED") throw new ClinicError("Only booked appointments can check in.", 409);
      await connection.execute(
        "UPDATE appointments SET status = 'CHECKED_IN', checked_in_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [id],
      );
      await this.audit(connection, id, "BOOKED", "CHECKED_IN", rows[0].patient_id);
      await connection.commit();
      this.emitUpdate(appointment.doctorId);
      return this.requireAppointment(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getQueue(doctorId: string, patientId?: string): Promise<QueueSnapshot> {
    const doctor = await this.requireDoctor(doctorId);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TIME_ZONE }).format(new Date());
    const start = clinicDateTime(day, 0).toISOString();
    const end = clinicDateTime(day, 24 * 60 - 1).toISOString();
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, status, token_number, patient_id FROM appointments
       WHERE doctor_id = ? AND starts_at >= ? AND starts_at < ?
         AND status IN ('BOOKED', 'CHECKED_IN')
       ORDER BY token_number`,
      [doctorId, dbDateTime(start), dbDateTime(end)],
    );
    const [metrics] = await this.pool.query<RowDataPacket[]>(
      "SELECT average_minutes FROM doctor_metrics WHERE doctor_id = ?",
      [doctorId],
    );
    const waiting = rows.filter((row) => row.status === "BOOKED");
    const inProgress = rows.filter((row) => row.status === "CHECKED_IN");
    const mine = patientId ? rows.find((row) => row.patient_id === patientId) : undefined;
    const currentToken = inProgress.length ? Math.max(...inProgress.map((row) => Number(row.token_number))) : 0;
    const ahead = mine && mine.status !== "CHECKED_IN"
      ? waiting.filter((row) => Number(row.token_number) < Number(mine.token_number)).length
      : 0;
    const averageConsultMinutes = Number(metrics[0]?.average_minutes ?? 18);
    return {
      doctorId,
      doctorName: doctor.name,
      queueDate: day,
      currentToken,
      waitingCount: waiting.length,
      myPosition: mine ? (mine.status === "CHECKED_IN" ? 0 : ahead + 1) : null,
      etaMinutes: mine ? (ahead + (inProgress.length ? 1 : 0)) * averageConsultMinutes : null,
      averageConsultMinutes,
      timeZone: CLINIC_TIME_ZONE,
    };
  }

  async completeNext(doctorId: string): Promise<Appointment | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id FROM appointments WHERE doctor_id = ? AND status = 'CHECKED_IN'
       ORDER BY token_number LIMIT 1`,
      [doctorId],
    );
    if (!rows.length) return null;
    const id = rows[0].id as string;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [current] = await connection.query<RowDataPacket[]>(
        "SELECT checked_in_at FROM appointments WHERE id = ? AND status = 'CHECKED_IN' FOR UPDATE",
        [id],
      );
      if (!current.length) {
        await connection.rollback();
        return null;
      }
      await connection.execute(
        "UPDATE appointments SET status = 'COMPLETED', completed_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [id],
      );
      await this.audit(connection, id, "CHECKED_IN", "COMPLETED", "");
      const elapsed = current[0].checked_in_at
        ? Math.max(5, Math.min(120, Math.round((Date.now() - new Date(current[0].checked_in_at).getTime()) / 60_000)))
        : 18;
      await connection.execute(
        `INSERT INTO doctor_metrics (doctor_id, average_minutes, sample_count)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE
           average_minutes = ROUND((average_minutes * sample_count + VALUES(average_minutes)) / (sample_count + 1), 1),
           sample_count = sample_count + 1`,
        [doctorId, elapsed],
      );
      const [next] = await connection.query<RowDataPacket[]>(
        `SELECT id, patient_id FROM appointments WHERE doctor_id = ? AND status = 'BOOKED'
         AND starts_at >= UTC_TIMESTAMP(3) ORDER BY token_number LIMIT 1 FOR UPDATE`,
        [doctorId],
      );
      if (next.length) {
        await connection.execute(
          "UPDATE appointments SET status = 'CHECKED_IN', checked_in_at = UTC_TIMESTAMP(3) WHERE id = ?",
          [next[0].id],
        );
        await this.audit(connection, next[0].id, "BOOKED", "CHECKED_IN", next[0].patient_id);
      }
      await connection.commit();
      this.emitUpdate(doctorId);
      return this.requireAppointment(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async sweepExpiredOffers(): Promise<void> {
    const [expired] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, doctor_id, patient_id, starts_at, ends_at FROM appointments
       WHERE status = 'OFFERED' AND offered_until <= UTC_TIMESTAMP(3) LIMIT 100`,
    );
    for (const appointment of expired) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        await this.lockSlot(connection, appointment.doctor_id, iso(appointment.starts_at)!, iso(appointment.ends_at)!);
        const [current] = await connection.query<RowDataPacket[]>(
          "SELECT status, patient_id FROM appointments WHERE id = ? FOR UPDATE",
          [appointment.id],
        );
        if (!current.length || current[0].status !== "OFFERED") {
          await connection.rollback();
          continue;
        }
        await connection.execute("UPDATE appointments SET status = 'EXPIRED' WHERE id = ?", [appointment.id]);
        await this.audit(connection, appointment.id, "OFFERED", "EXPIRED", current[0].patient_id);
        await this.offerNextWaitlisted(connection, appointment.doctor_id, iso(appointment.starts_at)!);
        await connection.commit();
        this.emitUpdate(appointment.doctor_id);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  }

  onQueueUpdate(listener: (doctorId: string) => void): () => void {
    this.events.on("queue-update", listener);
    return () => this.events.off("queue-update", listener);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async validateSlot(doctorId: string, startsAt: string): Promise<Slot> {
    if (!Number.isFinite(Date.parse(startsAt))) throw new ClinicError("A valid appointment time is required.", 400);
    const canonical = new Date(startsAt).toISOString();
    const date = clinicLocalDate(new Date(canonical));
    const [ruleRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT start_time, end_time, consultation_minutes
       FROM availability_rules WHERE doctor_id = ? AND weekday = ? ORDER BY start_time`,
      [doctorId, clinicWeekday(date)],
    );
    const rules = ruleRows.map((row) => ({
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time).slice(0, 5),
      consultationMinutes: Number(row.consultation_minutes),
    }));
    const slot = generateClinicSlots(date, rules).find((candidate) => candidate.startsAt === canonical);
    if (!slot) throw new ClinicError("That time is outside the doctor's working hours.", 400);
    const [leave] = await this.pool.query<RowDataPacket[]>(
      "SELECT id FROM doctor_leave WHERE doctor_id = ? AND leave_date = ? LIMIT 1",
      [doctorId, date],
    );
    if (leave.length) throw new ClinicError("The doctor is not available on this date.", 409);
    return slot;
  }

  private async lockPatient(connection: mysql.PoolConnection, patientId: string): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM patients WHERE id = ? FOR UPDATE",
      [patientId],
    );
    if (!rows.length) throw new ClinicError("Patient profile not found.", 404);
  }

  private async lockSlot(
    connection: mysql.PoolConnection,
    doctorId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM appointment_slots WHERE doctor_id = ? AND starts_at = ? FOR UPDATE",
      [doctorId, dbDateTime(startsAt)],
    );
    if (!rows.length) throw new ClinicError("This slot is no longer available.", 409);
  }

  private async materializeSlots(doctorId: string, slots: Slot[]): Promise<void> {
    if (!slots.length) return;
    const values = slots.flatMap((slot) => [
      doctorId,
      dbDateTime(slot.startsAt),
      dbDateTime(slot.endsAt),
    ]);
    const placeholders = slots.map(() => "(?, ?, ?)").join(", ");
    await this.pool.execute(
      `INSERT INTO appointment_slots (doctor_id, starts_at, ends_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE ends_at = VALUES(ends_at)`,
      values,
    );
  }

  private async assertNoOverlap(
    connection: mysql.PoolConnection,
    patientId: string,
    startsAt: string,
    endsAt: string,
    exceptId?: string,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM appointments
       WHERE patient_id = ? AND status IN ('BOOKED', 'OFFERED', 'CHECKED_IN')
         AND starts_at < ? AND ends_at > ? ${exceptId ? "AND id <> ?" : ""}
       LIMIT 1 FOR UPDATE`,
      exceptId
        ? [patientId, dbDateTime(endsAt), dbDateTime(startsAt), exceptId]
        : [patientId, dbDateTime(endsAt), dbDateTime(startsAt)],
    );
    if (rows.length) throw new ClinicError("You already have an appointment during this time.", 409);
  }

  private async nextToken(connection: mysql.PoolConnection, doctorId: string, startsAt: string): Promise<number> {
    const day = clinicLocalDate(new Date(startsAt));
    await connection.execute(
      "INSERT IGNORE INTO doctor_daily_counters (doctor_id, clinic_date, last_token) VALUES (?, ?, 0)",
      [doctorId, day],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT last_token FROM doctor_daily_counters WHERE doctor_id = ? AND clinic_date = ? FOR UPDATE",
      [doctorId, day],
    );
    const token = Number(rows[0].last_token) + 1;
    await connection.execute(
      "UPDATE doctor_daily_counters SET last_token = ? WHERE doctor_id = ? AND clinic_date = ?",
      [token, doctorId, day],
    );
    return token;
  }

  private async audit(
    connection: mysql.PoolConnection,
    appointmentId: string,
    fromStatus: AppointmentStatus | null,
    toStatus: AppointmentStatus,
    actorId: string,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO appointment_audit_log (appointment_id, from_status, to_status, actor_id, occurred_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [appointmentId, fromStatus, toStatus, actorId || "clinic-staff"],
    );
  }

  private async offerNextWaitlisted(
    connection: mysql.PoolConnection,
    doctorId: string,
    startsAt: string,
  ): Promise<void> {
    const [waiting] = await connection.query<RowDataPacket[]>(
      `SELECT id, patient_id FROM appointments
       WHERE doctor_id = ? AND starts_at = ? AND status = 'WAITLISTED'
       ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
      [doctorId, dbDateTime(startsAt)],
    );
    if (!waiting.length) return;
    const id = String(waiting[0].id);
    await connection.execute(
      "UPDATE appointments SET status = 'OFFERED', offered_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE) WHERE id = ?",
      [id],
    );
    await this.audit(connection, id, "WAITLISTED", "OFFERED", String(waiting[0].patient_id));
  }

  private async requireDoctor(id: string): Promise<Doctor> {
    const [rows] = await this.pool.query<DoctorRow[]>(
      `SELECT id, name, specialty, experience, rating, fee, initials, color, about
       FROM doctors WHERE id = ?`,
      [id],
    );
    if (!rows.length) throw new ClinicError("Doctor not found.", 404);
    return rows[0];
  }

  private async requireAppointment(id: string): Promise<Appointment> {
    const [rows] = await this.pool.query<AppointmentRow[]>(`${appointmentSelect} WHERE a.id = ? LIMIT 1`, [id]);
    if (!rows.length) throw new ClinicError("Appointment not found.", 404);
    return toAppointment(rows[0]);
  }

  private isDuplicate(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
  }

  private emitUpdate(doctorId: string): void {
    this.events.emit("queue-update", doctorId);
  }
}
