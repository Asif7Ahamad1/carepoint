import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createApp } from "../dist/app.js";
import { generateClinicSlots } from "../dist/availability.js";
import { MemoryClinicStore } from "../dist/memory-store.js";

const store = new MemoryClinicStore();
const app = createApp(store);
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

function futureWeekday(offset = 2) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function firstSlot(date) {
  const slot = generateClinicSlots(date).find((candidate) => candidate.available);
  assert.ok(slot, `Expected a future slot on ${date}`);
  return slot;
}

test("health and doctor endpoints expose the connected clinic", async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const doctors = await fetch(`${baseUrl}/api/doctors`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "demo");
  assert.equal(doctors.data.length, 8);
});

test("availability is generated from weekday clinic hours", async () => {
  const date = futureWeekday();
  const response = await fetch(`${baseUrl}/api/availability?doctorId=dr-ananya&date=${date}`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.data.length > 0);
  assert.equal(body.data.every((slot) => Date.parse(slot.endsAt) - Date.parse(slot.startsAt) === 20 * 60_000), true);
});

test("concurrent patients cannot claim the same slot", async () => {
  const slot = firstSlot(futureWeekday(4));
  const attempts = await Promise.allSettled([
    store.bookAppointment({ patientId: "patient-race-a", patientName: "Demo A", doctorId: "dr-ananya", startsAt: slot.startsAt }),
    store.bookAppointment({ patientId: "patient-race-b", patientName: "Demo B", doctorId: "dr-ananya", startsAt: slot.startsAt }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const all = await store.listAppointments();
  assert.equal(all.filter((appointment) =>
    appointment.doctorId === "dr-ananya" &&
    appointment.startsAt === slot.startsAt &&
    ["BOOKED", "OFFERED", "CHECKED_IN"].includes(appointment.status),
  ).length, 1);
});

test("one patient cannot book overlapping visits with two doctors", async () => {
  const slot = firstSlot(futureWeekday(8));
  const attempts = await Promise.allSettled([
    store.bookAppointment({ patientId: "patient-overlap", patientName: "Demo Patient", doctorId: "dr-ananya", startsAt: slot.startsAt }),
    store.bookAppointment({ patientId: "patient-overlap", patientName: "Demo Patient", doctorId: "dr-rahul", startsAt: slot.startsAt }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});

test("cancellation offers the slot to the first waitlisted patient", async () => {
  const slot = firstSlot(futureWeekday(12));
  const booked = await store.bookAppointment({
    patientId: "patient-booked",
    patientName: "First Patient",
    doctorId: "dr-meera",
    startsAt: slot.startsAt,
  });
  const waiting = await store.joinWaitlist({
    patientId: "patient-waiting",
    patientName: "Next Patient",
    doctorId: "dr-meera",
    startsAt: slot.startsAt,
  });
  await store.joinWaitlist({
    patientId: "patient-waiting-second",
    patientName: "Following Patient",
    doctorId: "dr-meera",
    startsAt: slot.startsAt,
  });

  const cancelled = await store.cancelAppointment(booked.id);
  assert.equal(cancelled.offered?.id, waiting.id);
  assert.equal(cancelled.offered?.status, "OFFERED");
  const accepted = await store.acceptOffer(waiting.id);
  assert.equal(accepted.status, "BOOKED");
  assert.equal((await store.getAvailability("dr-meera", slot.startsAt.slice(0, 10))).find((item) => item.startsAt === slot.startsAt)?.available, false);
});

test("an expired offer advances to the next waitlisted patient", async () => {
  const slot = firstSlot(futureWeekday(16));
  const booked = await store.bookAppointment({
    patientId: "patient-expiry-owner",
    patientName: "Slot Owner",
    doctorId: "dr-vikram",
    startsAt: slot.startsAt,
  });
  const first = await store.joinWaitlist({
    patientId: "patient-expiry-first",
    patientName: "First Waitlist Patient",
    doctorId: "dr-vikram",
    startsAt: slot.startsAt,
  });
  const second = await store.joinWaitlist({
    patientId: "patient-expiry-second",
    patientName: "Second Waitlist Patient",
    doctorId: "dr-vikram",
    startsAt: slot.startsAt,
  });
  await store.cancelAppointment(booked.id);
  first.offeredUntil = new Date(Date.now() - 1_000).toISOString();
  await store.sweepExpiredOffers();

  assert.equal(first.status, "EXPIRED");
  assert.equal(second.status, "OFFERED");
  assert.ok(Date.parse(second.offeredUntil) > Date.now());
});

test("queue completion updates its rolling consultation estimate and broadcasts", async () => {
  const before = await store.getQueue("dr-ananya");
  let updatedDoctor = "";
  const unsubscribe = store.onQueueUpdate((doctorId) => {
    updatedDoctor = doctorId;
  });
  const completed = await store.completeNext("dr-ananya");
  unsubscribe();
  const after = await store.getQueue("dr-ananya");
  assert.equal(completed?.status, "COMPLETED");
  assert.equal(updatedDoctor, "dr-ananya");
  assert.notEqual(after.averageConsultMinutes, before.averageConsultMinutes);
});

test("invalid booking requests receive a clear client error", async () => {
  const response = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId: "patient-demo", patientName: "Aarav Sharma", doctorId: "dr-ananya", startsAt: "not-a-date" }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /valid ISO date-time/i);
});
