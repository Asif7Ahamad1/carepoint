import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  ClinicError,
  CLINIC_TIME_ZONE,
  type BookAppointmentInput,
  type ClinicStore,
} from "./domain.js";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ClinicError(`${field} is required.`, 400);
  }
  return value.trim();
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
      const patientId = request.query.patientId === undefined
        ? undefined
        : requiredString(request.query.patientId, "patientId");
      const doctorId = request.query.doctorId === undefined
        ? undefined
        : requiredString(request.query.doctorId, "doctorId");
      response.json({ data: await store.listAppointments(patientId, doctorId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/appointments", async (request, response, next) => {
    try {
      response.status(201).json({ data: await store.bookAppointment(appointmentInput(request.body)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/waitlist", async (request, response, next) => {
    try {
      response.status(201).json({ data: await store.joinWaitlist(appointmentInput(request.body)) });
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
