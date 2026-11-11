import { EventEmitter } from "node:events";
import { clinicLocalDate, generateClinicSlots } from "./availability.js";
import {
  ACTIVE_STATUSES,
  ClinicError,
  CLINIC_TIME_ZONE,
  CONSULTATION_MINUTES,
  type Appointment,
  type AppointmentStatus,
  type BookAppointmentInput,
  type ClinicStore,
  type Doctor,
  type QueueSnapshot,
  type Slot,
} from "./domain.js";

const doctors: Doctor[] = [
  { id: "dr-ananya", name: "Dr. Ananya Rao", specialty: "Cardiology", experience: 12, rating: 4.96, fee: 800, initials: "AR", color: "lavender", about: "Preventive cardiology and heart health" },
  { id: "dr-rahul", name: "Dr. Rahul Menon", specialty: "Dermatology", experience: 9, rating: 4.91, fee: 650, initials: "RM", color: "mint", about: "Clinical and cosmetic dermatology" },
  { id: "dr-meera", name: "Dr. Meera Kapoor", specialty: "Pediatrics", experience: 15, rating: 4.98, fee: 700, initials: "MK", color: "peach", about: "Gentle, family-centred child care" },
  { id: "dr-vikram", name: "Dr. Vikram Shah", specialty: "Orthopedics", experience: 11, rating: 4.89, fee: 900, initials: "VS", color: "blue", about: "Sports injuries and joint care" },
  { id: "dr-sana", name: "Dr. Sana Iyer", specialty: "General medicine", experience: 8, rating: 4.94, fee: 500, initials: "SI", color: "rose", about: "Everyday health and preventive care" },
  { id: "dr-arjun", name: "Dr. Arjun Das", specialty: "Neurology", experience: 14, rating: 4.93, fee: 1000, initials: "AD", color: "sand", about: "Headache, sleep and neurological care" },
  { id: "dr-neha", name: "Dr. Neha Kulkarni", specialty: "Gynecology", experience: 10, rating: 4.97, fee: 850, initials: "NK", color: "mint", about: "Women's wellness through every life stage" },
  { id: "dr-kabir", name: "Dr. Kabir Sethi", specialty: "ENT", experience: 7, rating: 4.88, fee: 600, initials: "KS", color: "lavender", about: "Ear, nose and throat consultations" },
];

const averageMinutes = new Map<string, number>(doctors.map((doctor) => [doctor.id, 18]));
const averageSamples = new Map<string, number>(doctors.map((doctor) => [doctor.id, 0]));
const leaveDates = new Set<string>();

function localDate(date = new Date()): string {
  return clinicLocalDate(date);
}

function makeId(): string {
  return `apt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(keys: string[], action: () => T | Promise<T>): Promise<T> {
    const sortedKeys = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    for (const key of sortedKeys) {
      const previous = this.tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.tails.set(key, current);
      await previous;
      releases.push(() => {
        release();
        if (this.tails.get(key) === current) this.tails.delete(key);
      });
    }
    try {
      return await action();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

export class MemoryClinicStore implements ClinicStore {
  readonly mode = "demo" as const;
  private readonly appointments: Appointment[] = [];
  private readonly events = new EventEmitter();
  private readonly mutex = new KeyedMutex();
  private readonly checkInTimes = new Map<string, number>();

  constructor() {
    const now = Date.now();
    this.addSampleAppointment(doctors[0], new Date(now - 12 * 60_000).toISOString(), "CHECKED_IN", 1, "patient-sample-1", "Maya Kapoor");
    this.addSampleAppointment(doctors[0], new Date(now + 8 * 60_000).toISOString(), "BOOKED", 2, "patient-sample-2", "Rohan Mehta");
    this.addSampleAppointment(doctors[0], new Date(now + 28 * 60_000).toISOString(), "BOOKED", 3, "patient-demo", "Aarav Sharma");
  }

  async listDoctors(): Promise<Doctor[]> {
    return doctors;
  }

  async getAvailability(doctorId: string, date: string): Promise<Slot[]> {
    this.requireDoctor(doctorId);
    if (leaveDates.has(`${doctorId}:${date}`)) return [];
    const slots = generateClinicSlots(date);
    return slots.map((slot) => {
      const sameSlot = this.appointments.filter((appointment) =>
        appointment.doctorId === doctorId &&
        appointment.startsAt === slot.startsAt &&
        ["BOOKED", "OFFERED", "CHECKED_IN"].includes(appointment.status),
      );
      return {
        ...slot,
        available: sameSlot.length === 0,
        waitlistCount: this.appointments.filter((appointment) =>
          appointment.doctorId === doctorId &&
          appointment.startsAt === slot.startsAt &&
          appointment.status === "WAITLISTED",
        ).length,
      };
    });
  }

  async listAppointments(patientId?: string, doctorId?: string): Promise<Appointment[]> {
    return this.appointments
      .filter((appointment) =>
        (!patientId || appointment.patientId === patientId) &&
        (!doctorId || appointment.doctorId === doctorId),
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async bookAppointment(input: BookAppointmentInput): Promise<Appointment> {
    return this.mutex.run(
      [`patient:${input.patientId}`, `slot:${input.doctorId}:${input.startsAt}`],
      () => {
        const doctor = this.requireDoctor(input.doctorId);
        const slot = this.validSlot(doctor.id, input.startsAt);
        if (!slot) throw new ClinicError("That time is outside the doctor's working hours.", 400);
        if (this.activeAt(doctor.id, slot.startsAt)) {
          throw new ClinicError("That slot was just taken. Choose another time or join the waitlist.", 409);
        }
        this.assertNoPatientOverlap(input.patientId, slot.startsAt, slot.endsAt);
        const appointment = this.makeAppointment(input, doctor.name, slot, "BOOKED");
        this.appointments.push(appointment);
        this.emitUpdate(doctor.id);
        return appointment;
      },
    );
  }

  async joinWaitlist(input: BookAppointmentInput): Promise<Appointment> {
    const doctor = this.requireDoctor(input.doctorId);
    const slot = this.validSlot(doctor.id, input.startsAt);
    if (!slot) throw new ClinicError("That time is outside the doctor's working hours.", 400);
    return this.mutex.run([`slot:${doctor.id}:${slot.startsAt}`], () => {
      if (!this.activeAt(doctor.id, slot.startsAt)) {
        throw new ClinicError("This slot is available now; book it instead of joining the waitlist.", 409);
      }
      if (this.appointments.some((appointment) =>
        appointment.patientId === input.patientId &&
        appointment.doctorId === doctor.id &&
        appointment.startsAt === slot.startsAt &&
        appointment.status === "WAITLISTED",
      )) {
        throw new ClinicError("You're already on the waitlist for this slot.", 409);
      }
      const appointment = this.makeAppointment(input, doctor.name, slot, "WAITLISTED");
      this.appointments.push(appointment);
      return appointment;
    });
  }

  async cancelAppointment(id: string): Promise<{ appointment: Appointment; offered: Appointment | null }> {
    const appointment = this.requireAppointment(id);
    return this.mutex.run(
      [`slot:${appointment.doctorId}:${appointment.startsAt}`],
      () => {
        const current = this.requireAppointment(id);
        if (!["BOOKED", "OFFERED", "CHECKED_IN"].includes(current.status)) {
          throw new ClinicError("This appointment can no longer be cancelled.", 409);
        }
        current.status = "CANCELLED";
        const next = this.appointments
          .filter((candidate) =>
            candidate.doctorId === current.doctorId &&
            candidate.startsAt === current.startsAt &&
            candidate.status === "WAITLISTED",
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        let offered: Appointment | null = null;
        if (next) {
          next.status = "OFFERED";
          next.offeredUntil = new Date(Date.now() + 10 * 60_000).toISOString();
          offered = next;
        }
        this.emitUpdate(current.doctorId);
        return { appointment: current, offered };
      },
    );
  }

  async acceptOffer(id: string): Promise<Appointment> {
    const appointment = this.requireAppointment(id);
    return this.mutex.run(
      [`patient:${appointment.patientId}`, `slot:${appointment.doctorId}:${appointment.startsAt}`],
      () => {
        const current = this.requireAppointment(id);
        if (current.status !== "OFFERED" || !current.offeredUntil) {
          throw new ClinicError("This waitlist offer is no longer active.", 409);
        }
        if (Date.parse(current.offeredUntil) <= Date.now()) {
          current.status = "EXPIRED";
          this.offerNext(current.doctorId, current.startsAt);
          this.emitUpdate(current.doctorId);
          throw new ClinicError("This offer has expired.", 410);
        }
        this.assertNoPatientOverlap(current.patientId, current.startsAt, current.endsAt, current.id);
        current.status = "BOOKED";
        current.offeredUntil = undefined;
        this.emitUpdate(current.doctorId);
        return current;
      },
    );
  }

  async checkIn(id: string): Promise<Appointment> {
    const appointment = this.requireAppointment(id);
    if (appointment.status !== "BOOKED") throw new ClinicError("Only booked appointments can check in.", 409);
    appointment.status = "CHECKED_IN";
    this.checkInTimes.set(id, Date.now());
    this.emitUpdate(appointment.doctorId);
    return appointment;
  }

  async getQueue(doctorId: string, patientId?: string): Promise<QueueSnapshot> {
    const doctor = this.requireDoctor(doctorId);
    const queueDate = localDate();
    const queue = this.appointments
      .filter((appointment) =>
        appointment.doctorId === doctorId &&
        localDate(new Date(appointment.startsAt)) === queueDate &&
        ["BOOKED", "CHECKED_IN"].includes(appointment.status),
      )
      .sort((a, b) => a.tokenNumber - b.tokenNumber);
    const inProgress = queue.filter((appointment) => appointment.status === "CHECKED_IN");
    const waiting = queue.filter((appointment) => appointment.status === "BOOKED");
    const mine = patientId ? queue.find((appointment) => appointment.patientId === patientId) : undefined;
    const nextToken = inProgress.length ? inProgress[0].tokenNumber : 0;
    const ahead = mine
      ? waiting.filter((appointment) => appointment.tokenNumber < mine.tokenNumber).length +
        0
      : null;
    const averageConsultMinutes = averageMinutes.get(doctorId) ?? CONSULTATION_MINUTES;
    return {
      doctorId,
      doctorName: doctor.name,
      queueDate,
      currentToken: nextToken,
      waitingCount: waiting.length,
      myPosition: mine ? (mine.status === "CHECKED_IN" ? 0 : (ahead ?? 0) + 1) : null,
      etaMinutes: mine
        ? (mine.status === "CHECKED_IN" ? 0 : ((ahead ?? 0) + (inProgress.length ? 1 : 0)) * averageConsultMinutes)
        : null,
      averageConsultMinutes,
      timeZone: CLINIC_TIME_ZONE,
    };
  }

  async completeNext(doctorId: string): Promise<Appointment | null> {
    const current = this.appointments
      .filter((appointment) => appointment.doctorId === doctorId && appointment.status === "CHECKED_IN")
      .sort((a, b) => a.tokenNumber - b.tokenNumber)[0];
    if (!current) return null;
    current.status = "COMPLETED";
    const now = Date.now();
    const checkedInAt = this.checkInTimes.get(current.id);
    const duration = checkedInAt === undefined ? 18 : Math.max(5, Math.min(120, Math.round((now - checkedInAt) / 60_000)));
    const sampleCount = averageSamples.get(doctorId) ?? 0;
    const average = averageMinutes.get(doctorId) ?? 18;
    averageMinutes.set(doctorId, Math.round(((average * sampleCount + duration) / (sampleCount + 1)) * 10) / 10);
    averageSamples.set(doctorId, sampleCount + 1);
    this.checkInTimes.delete(current.id);
    const next = this.appointments
      .filter((appointment) =>
        appointment.doctorId === doctorId &&
        localDate(new Date(appointment.startsAt)) === localDate(new Date(current.startsAt)) &&
        appointment.status === "BOOKED",
      )
      .sort((a, b) => a.tokenNumber - b.tokenNumber)[0];
    if (next) {
      next.status = "CHECKED_IN";
      this.checkInTimes.set(next.id, now);
    }
    this.emitUpdate(doctorId);
    return current;
  }

  async sweepExpiredOffers(): Promise<void> {
    const expired = this.appointments.filter((appointment) =>
      appointment.status === "OFFERED" &&
      appointment.offeredUntil !== undefined &&
      Date.parse(appointment.offeredUntil) <= Date.now(),
    );
    for (const appointment of expired) {
      await this.mutex.run(
        [`slot:${appointment.doctorId}:${appointment.startsAt}`],
        () => {
          if (appointment.status !== "OFFERED" || !appointment.offeredUntil || Date.parse(appointment.offeredUntil) > Date.now()) return;
          appointment.status = "EXPIRED";
          this.offerNext(appointment.doctorId, appointment.startsAt);
          this.emitUpdate(appointment.doctorId);
        },
      );
    }
  }

  onQueueUpdate(listener: (doctorId: string) => void): () => void {
    this.events.on("queue-update", listener);
    return () => this.events.off("queue-update", listener);
  }

  async close(): Promise<void> {}

  private addSampleAppointment(
    doctor: Doctor,
    startsAt: string,
    status: AppointmentStatus,
    tokenNumber: number,
    patientId: string,
    patientName: string,
  ): void {
    this.appointments.push({
      id: makeId(),
      doctorId: doctor.id,
      doctorName: doctor.name,
      patientId,
      patientName,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + CONSULTATION_MINUTES * 60_000).toISOString(),
      status,
      tokenNumber,
      createdAt: new Date().toISOString(),
    });
    if (status === "CHECKED_IN") this.checkInTimes.set(this.appointments[this.appointments.length - 1].id, Date.now() - 12 * 60_000);
  }

  private makeAppointment(
    input: BookAppointmentInput,
    doctorName: string,
    slot: Slot,
    status: AppointmentStatus,
  ): Appointment {
    const tokenNumber = this.appointments.filter((appointment) =>
      appointment.doctorId === input.doctorId &&
      localDate(new Date(appointment.startsAt)) === localDate(new Date(slot.startsAt)),
    ).length + 1;
    return {
      id: makeId(),
      doctorId: input.doctorId,
      doctorName,
      patientId: input.patientId,
      patientName: input.patientName,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status,
      tokenNumber,
      createdAt: new Date().toISOString(),
    };
  }

  private validSlot(doctorId: string, startsAt: string): Slot | undefined {
    const date = localDate(new Date(startsAt));
    return generateClinicSlots(date).find((slot) => slot.startsAt === new Date(startsAt).toISOString() &&
      this.doctorsHasWorkday(doctorId, date));
  }

  private doctorsHasWorkday(doctorId: string, date: string): boolean {
    return !leaveDates.has(`${doctorId}:${date}`) && doctors.some((doctor) => doctor.id === doctorId);
  }

  private activeAt(doctorId: string, startsAt: string): Appointment | undefined {
    return this.appointments.find((appointment) =>
      appointment.doctorId === doctorId &&
      appointment.startsAt === startsAt &&
      ACTIVE_STATUSES.includes(appointment.status),
    );
  }

  private offerNext(doctorId: string, startsAt: string): void {
    const next = this.appointments
      .filter((candidate) =>
        candidate.doctorId === doctorId &&
        candidate.startsAt === startsAt &&
        candidate.status === "WAITLISTED",
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) {
      next.status = "OFFERED";
      next.offeredUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    }
  }

  private assertNoPatientOverlap(
    patientId: string,
    startsAt: string,
    endsAt: string,
    exceptId?: string,
  ): void {
    const conflict = this.appointments.some((appointment) =>
      appointment.patientId === patientId &&
      appointment.id !== exceptId &&
      ACTIVE_STATUSES.includes(appointment.status) &&
      new Date(appointment.startsAt).getTime() < new Date(endsAt).getTime() &&
      new Date(appointment.endsAt).getTime() > new Date(startsAt).getTime(),
    );
    if (conflict) throw new ClinicError("You already have an appointment during this time.", 409);
  }

  private requireDoctor(id: string): Doctor {
    const doctor = doctors.find((candidate) => candidate.id === id);
    if (!doctor) throw new ClinicError("Doctor not found.", 404);
    return doctor;
  }

  private requireAppointment(id: string): Appointment {
    const appointment = this.appointments.find((candidate) => candidate.id === id);
    if (!appointment) throw new ClinicError("Appointment not found.", 404);
    return appointment;
  }

  private emitUpdate(doctorId: string): void {
    this.events.emit("queue-update", doctorId);
  }
}
