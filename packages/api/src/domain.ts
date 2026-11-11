export type AppointmentStatus =
  | "BOOKED"
  | "WAITLISTED"
  | "OFFERED"
  | "CHECKED_IN"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  experience: number;
  rating: number;
  fee: number;
  initials: string;
  color: string;
  about: string;
}

export interface Appointment {
  id: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  tokenNumber: number;
  offeredUntil?: string;
  createdAt: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  available: boolean;
  waitlistCount: number;
}

export interface AvailabilityRule {
  startTime: string;
  endTime: string;
  consultationMinutes: number;
}

export interface QueueSnapshot {
  doctorId: string;
  doctorName: string;
  queueDate: string;
  currentToken: number;
  waitingCount: number;
  myPosition: number | null;
  etaMinutes: number | null;
  averageConsultMinutes: number;
  timeZone: string;
}

export interface BookAppointmentInput {
  patientId: string;
  patientName: string;
  doctorId: string;
  startsAt: string;
}

export type AccountRole = "patient" | "doctor";
export type AccountStatus = "active" | "pending";

export interface DoctorApplicationInput {
  specialty: string;
  experience: number;
  fee: number;
  about: string;
  licenseNumber: string;
}

export interface RegisterAccountInput {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: AccountRole;
  doctorApplication?: DoctorApplicationInput;
}

export interface Account {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  status: AccountStatus;
}

export interface StoredAccount {
  account: Account;
  passwordHash: string;
}

export interface ClinicStore {
  readonly mode: "demo" | "mysql";
  registerAccount(input: RegisterAccountInput): Promise<Account>;
  findAccountByEmail(email: string): Promise<StoredAccount | null>;
  createSession(accountId: string, tokenHash: string, expiresAt: string): Promise<void>;
  findSession(tokenHash: string): Promise<Account | null>;
  revokeSession(tokenHash: string): Promise<void>;
  listDoctors(): Promise<Doctor[]>;
  getAvailability(doctorId: string, date: string): Promise<Slot[]>;
  listAppointments(patientId?: string, doctorId?: string): Promise<Appointment[]>;
  bookAppointment(input: BookAppointmentInput): Promise<Appointment>;
  joinWaitlist(input: BookAppointmentInput): Promise<Appointment>;
  cancelAppointment(id: string): Promise<{ appointment: Appointment; offered: Appointment | null }>;
  acceptOffer(id: string): Promise<Appointment>;
  checkIn(id: string): Promise<Appointment>;
  getQueue(doctorId: string, patientId?: string): Promise<QueueSnapshot>;
  completeNext(doctorId: string): Promise<Appointment | null>;
  sweepExpiredOffers(): Promise<void>;
  onQueueUpdate(listener: (doctorId: string) => void): () => void;
  close(): Promise<void>;
}

export class ClinicError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ClinicError";
  }
}

export const ACTIVE_STATUSES: AppointmentStatus[] = ["BOOKED", "OFFERED", "CHECKED_IN"];
export const CLINIC_TIME_ZONE = process.env.CLINIC_TIME_ZONE || "Asia/Kolkata";
export const CONSULTATION_MINUTES = 20;
