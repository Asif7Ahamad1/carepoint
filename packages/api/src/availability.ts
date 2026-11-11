import { ClinicError, CLINIC_TIME_ZONE, CONSULTATION_MINUTES, type AvailabilityRule, type Slot } from "./domain.js";

export const DEFAULT_AVAILABILITY_RULES: AvailabilityRule[] = [
  { startTime: "10:00", endTime: "14:00", consultationMinutes: CONSULTATION_MINUTES },
  { startTime: "17:00", endTime: "20:00", consultationMinutes: CONSULTATION_MINUTES },
];

export function clinicDateTime(date: string, minutes: number): Date {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const remainder = String(minutes % 60).padStart(2, "0");
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, Number(hours), Number(remainder));
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
    const delta = target - represented;
    timestamp += delta;
    if (delta === 0) return new Date(timestamp);
  }
  throw new Error(`Local time does not exist in ${CLINIC_TIME_ZONE}: ${date} ${hours}:${remainder}.`);
}

export function clinicWeekday(date: string): number {
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new ClinicError("Date must be a valid YYYY-MM-DD calendar date.", 400);
  }
  return parsedDate.getUTCDay();
}

export function clinicLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function generateClinicSlots(date: string, rules: AvailabilityRule[] = DEFAULT_AVAILABILITY_RULES): Slot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ClinicError("Date must use YYYY-MM-DD.", 400);
  }
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new ClinicError("Date is not a valid calendar date.", 400);
  }
  const weekday = parsedDate.getUTCDay();
  if (weekday === 0 || weekday === 6 || rules.length === 0) return [];

  const now = Date.now();
  const slots: Slot[] = [];
  for (const rule of rules) {
    const [startHour, startMinute] = rule.startTime.split(":").map(Number);
    const [endHour, endMinute] = rule.endTime.split(":").map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (!Number.isInteger(rule.consultationMinutes) || rule.consultationMinutes < 1 || start >= end) {
      throw new Error("Availability rules must have a valid duration and a start before the end.");
    }
    for (let minute = start; minute + rule.consultationMinutes <= end; minute += rule.consultationMinutes) {
      const startsAt = clinicDateTime(date, minute);
      if (startsAt.getTime() <= now) continue;
      slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + rule.consultationMinutes * 60_000).toISOString(),
        available: true,
        waitlistCount: 0,
      });
    }
  }
  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
