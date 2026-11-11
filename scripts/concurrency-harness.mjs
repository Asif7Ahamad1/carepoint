import assert from "node:assert/strict";

const api = process.env.API_URL || "http://localhost:4000/api";
let timeZone = process.env.CLINIC_TIME_ZONE || "Asia/Kolkata";

function clinicDateIn(daysAhead) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function get(path) {
  const response = await fetch(`${api}${path}`);
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `GET ${path} failed with ${response.status}`);
  return body.data;
}

async function book(payload) {
  const response = await fetch(`${api}/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function cancel(id) {
  await fetch(`${api}/appointments/${id}/cancel`, { method: "POST" });
}

const healthResponse = await fetch(`${api}/health`);
assert.equal(healthResponse.ok, true, "API must be running before the concurrency harness starts.");
const health = await healthResponse.json();
timeZone = process.env.CLINIC_TIME_ZONE || health.timeZone || timeZone;
const date = clinicDateIn(14);
const doctorId = "dr-ananya";
const slots = await get(`/availability?doctorId=${doctorId}&date=${date}`);
const slot = slots.find((candidate) => candidate.available);
assert.ok(slot, `No test slot available on ${date}. Try another weekday.`);

const contenders = [
  { patientId: "patient-0001", patientName: "Harness Patient 0001", doctorId, startsAt: slot.startsAt },
  { patientId: "patient-0002", patientName: "Harness Patient 0002", doctorId, startsAt: slot.startsAt },
];
const race = await Promise.all(contenders.map(book));
const winners = race.filter((result) => result.status === 201);
const conflicts = race.filter((result) => result.status === 409);
assert.equal(winners.length, 1, `Expected one booking winner; received statuses ${race.map((result) => result.status).join(", ")}`);
assert.equal(conflicts.length, 1, "The competing booking must receive HTTP 409.");
const winner = winners[0].body.data;
try {
  const otherDoctor = (await get("/doctors")).find((doctor) => doctor.id !== doctorId);
  assert.ok(otherDoctor, "A second doctor is required for the patient-overlap check.");
  const otherSlots = await get(`/availability?doctorId=${otherDoctor.id}&date=${date}`);
  assert.ok(otherSlots.some((candidate) => candidate.startsAt === slot.startsAt), "Doctors should share the tested working-hours slot.");
  const overlap = await book({
    patientId: winner.patientId,
    patientName: winner.patientName,
    doctorId: otherDoctor.id,
    startsAt: slot.startsAt,
  });
  assert.equal(overlap.status, 409, "A patient must not hold overlapping appointments with different doctors.");
  console.log(`PASS: concurrent slot race returned ${race.map((result) => result.status).join(" and ")}.`);
  console.log(`PASS: patient overlap across ${doctorId} and ${otherDoctor.id} returned ${overlap.status}.`);
} finally {
  await cancel(winner.id);
  console.log("The temporary winning appointment was cancelled.");
}
