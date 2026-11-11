import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { hashPassword, hashSessionToken, newSessionToken, verifyPassword } from "./auth.js";
import {
  type Account,
  ClinicError,
  CLINIC_TIME_ZONE,
  type BookAppointmentInput,
  type ClinicStore,
  type DoctorApplicationInput,
  type RegisterAccountInput,
} from "./domain.js";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ClinicError(`${field} is required.`, 400);
  }
  return value.trim();
}

function registrationInput(body: unknown): Omit<RegisterAccountInput, "id" | "passwordHash"> & { password: string } {
  if (typeof body !== "object" || body === null) throw new ClinicError("Request body must be an object.", 400);
  const values = body as Record<string, unknown>;
  const name = requiredString(values.name, "Name");
  const email = requiredString(values.email, "Email").toLowerCase();
  const password = requiredString(values.password, "Password");
  if (name.length < 2 || name.length > 120) throw new ClinicError("Name must be between 2 and 120 characters.", 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ClinicError("Enter a valid email address.", 400);
  }
  if (password.length < 10 || password.length > 128) {
    throw new ClinicError("Password must be between 10 and 128 characters.", 400);
  }
  if (values.role !== "patient" && values.role !== "doctor") {
    throw new ClinicError("Choose patient or doctor registration.", 400);
  }
  if (values.role === "patient") return { name, email, password, role: "patient" };

  const doctor = typeof values.doctorApplication === "object" && values.doctorApplication !== null
    ? values.doctorApplication as Record<string, unknown>
    : {};
  const specialty = requiredString(doctor.specialty, "Specialty");
  const about = requiredString(doctor.about, "Professional introduction");
  const licenseNumber = requiredString(doctor.licenseNumber, "Medical registration number");
  const experience = doctor.experience;
  const fee = doctor.fee;
  if (specialty.length > 80 || about.length > 180 || licenseNumber.length > 80) {
    throw new ClinicError("Doctor application details exceed the allowed length.", 400);
  }
  if (!Number.isInteger(experience) || Number(experience) < 0 || Number(experience) > 60) {
    throw new ClinicError("Experience must be a whole number from 0 to 60.", 400);
  }
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0 || fee > 100_000) {
    throw new ClinicError("Consultation fee must be between 0 and 100000.", 400);
  }
  const doctorApplication: DoctorApplicationInput = {
    specialty,
    experience: Number(experience),
    fee,
    about,
    licenseNumber,
  };
  return { name, email, password, role: "doctor", doctorApplication };
}

function credentials(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null) throw new ClinicError("Request body must be an object.", 400);
  const values = body as Record<string, unknown>;
  const email = requiredString(values.email, "Email").toLowerCase();
  const password = requiredString(values.password, "Password");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ClinicError("Enter a valid email address.", 400);
  }
  if (password.length > 128) throw new ClinicError("Email or password is incorrect.", 401);
  return { email, password };
}

function sessionToken(request: Request): string | null {
  const header = request.header("authorization");
  if (!header) return null;
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  if (!match) throw new ClinicError("Invalid sign-in session.", 401);
  return match[1];
}

async function accountFromRequest(request: Request, store: ClinicStore): Promise<Account | null> {
  const token = sessionToken(request);
  return token ? store.findSession(hashSessionToken(token)) : null;
}

async function createSession(store: ClinicStore, account: Account): Promise<{ account: Account; token: string }> {
  const token = newSessionToken();
  await store.createSession(account.id, hashSessionToken(token), new Date(Date.now() + SESSION_LIFETIME_MS).toISOString());
  return { account, token };
}

function appointmentInput(body: unknown): BookAppointmentInput {
  if (typeof body !== "object" || body === null) throw new ClinicError("Request body must be an object.", 400);
  const values = body as Record<string, unknown>;
  const startsAt = requiredString(values.startsAt, "startsAt");
  if (!Number.isFinite(Date.parse(startsAt))) throw new ClinicError("startsAt must be a valid ISO date-time.", 400);
  return {
    patientId: requiredString(values.patientId, "patientId"),
    patientName: requiredString(values.patientName, "patientName"),
    doctorId: requiredString(values.doctorId, "doctorId"),
    startsAt: new Date(startsAt).toISOString(),
  };
}

export function createApp(store: ClinicStore, webOrigin = "http://localhost:5173") {
  const app = express();
  app.use(cors({ origin: webOrigin }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", mode: store.mode, timeZone: CLINIC_TIME_ZONE });
  });

  app.post("/api/auth/register", async (request, response, next) => {
    try {
      const { password, ...details } = registrationInput(request.body);
      const input: RegisterAccountInput = {
        ...details,
        id: randomUUID(),
        passwordHash: await hashPassword(password),
      };
      const account = await store.registerAccount(input);
      response.status(201).json({ data: await createSession(store, account) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    try {
      const { email, password } = credentials(request.body);
      const stored = await store.findAccountByEmail(email);
      if (!stored || !(await verifyPassword(password, stored.passwordHash))) {
        throw new ClinicError("Email or password is incorrect.", 401);
      }
      response.json({ data: await createSession(store, stored.account) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/me", async (request, response, next) => {
    try {
      const account = await accountFromRequest(request, store);
      if (!account) throw new ClinicError("Please sign in to continue.", 401);
      response.json({ data: account });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", async (request, response, next) => {
    try {
      const token = sessionToken(request);
      if (token) await store.revokeSession(hashSessionToken(token));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doctors", async (_request, response, next) => {
    try {
      response.json({ data: await store.listDoctors() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/availability", async (request, response, next) => {
    try {
      const doctorId = requiredString(request.query.doctorId, "doctorId");
      const date = requiredString(request.query.date, "date");
      response.json({ data: await store.getAvailability(doctorId, date) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/appointments", async (request, response, next) => {
    try {
      const account = await accountFromRequest(request, store);
      const requestedPatientId = request.query.patientId === undefined
        ? undefined
        : requiredString(request.query.patientId, "patientId");
      const doctorId = request.query.doctorId === undefined
        ? undefined
        : requiredString(request.query.doctorId, "doctorId");
      const patientId = account?.role === "patient" ? account.id : requestedPatientId;
      response.json({ data: await store.listAppointments(patientId, doctorId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/appointments", async (request, response, next) => {
    try {
      const input = appointmentInput(request.body);
      const account = await accountFromRequest(request, store);
      if (account) {
        if (account.role !== "patient" || account.status !== "active") {
          throw new ClinicError("An active patient account is required to book an appointment.", 403);
        }
        input.patientId = account.id;
        input.patientName = account.name;
      }
      response.status(201).json({ data: await store.bookAppointment(input) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/waitlist", async (request, response, next) => {
    try {
      const input = appointmentInput(request.body);
      const account = await accountFromRequest(request, store);
      if (account) {
        if (account.role !== "patient" || account.status !== "active") {
          throw new ClinicError("An active patient account is required to join the waitlist.", 403);
        }
        input.patientId = account.id;
        input.patientName = account.name;
      }
      response.status(201).json({ data: await store.joinWaitlist(input) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/appointments/:id/cancel", async (request, response, next) => {
    try {
      response.json({ data: await store.cancelAppointment(requiredString(request.params.id, "id")) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/waitlist/:id/accept", async (request, response, next) => {
    try {
      response.json({ data: await store.acceptOffer(requiredString(request.params.id, "id")) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/appointments/:id/check-in", async (request, response, next) => {
    try {
      response.json({ data: await store.checkIn(requiredString(request.params.id, "id")) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doctors/:doctorId/queue", async (request, response, next) => {
    try {
      const doctorId = requiredString(request.params.doctorId, "doctorId");
      const patientId = request.query.patientId === undefined
        ? undefined
        : requiredString(request.query.patientId, "patientId");
      response.json({ data: await store.getQueue(doctorId, patientId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doctors/:doctorId/queue/complete-next", async (request, response, next) => {
    try {
      response.json({ data: await store.completeNext(requiredString(request.params.doctorId, "doctorId")) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doctors/:doctorId/queue/stream", (request, response) => {
    const doctorId = requiredString(request.params.doctorId, "doctorId");
    response.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write(`event: connected\ndata: ${JSON.stringify({ doctorId })}\n\n`);
    const unsubscribe = store.onQueueUpdate((updatedDoctorId) => {
      if (updatedDoctorId === doctorId) response.write("event: queue-update\ndata: {}\n\n");
    });
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Route not found." });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ClinicError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Invalid JSON request body." });
      return;
    }
    console.error(error);
    response.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
