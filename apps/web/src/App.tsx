import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Heart,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

const API = import.meta.env.VITE_API_BASE || "";
const TIME_ZONE = import.meta.env.VITE_CLINIC_TIME_ZONE || "Asia/Kolkata";
const PATIENT_ID = "patient-demo";
const PATIENT_NAME = "Aarav Sharma";

type Doctor = {
  id: string;
  name: string;
  specialty: string;
  experience: number;
  rating: number;
  fee: number;
  initials: string;
  color: string;
  about: string;
};

type Slot = { startsAt: string; endsAt: string; available: boolean; waitlistCount: number };
type Appointment = {
  id: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  startsAt: string;
  endsAt: string;
  status: "BOOKED" | "WAITLISTED" | "OFFERED" | "CHECKED_IN" | "COMPLETED" | "CANCELLED" | "EXPIRED";
  tokenNumber: number;
  offeredUntil?: string;
};
type Queue = {
  doctorId: string;
  doctorName: string;
  queueDate: string;
  currentToken: number;
  waitingCount: number;
  myPosition: number | null;
  etaMinutes: number | null;
  averageConsultMinutes: number;
  timeZone: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json() as { data?: T; error?: string };
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body.data as T;
}

function clinicToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOffset(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

function formatAppointmentDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

const navigation = ["Overview", "Appointments", "Queue"] as const;
type Page = (typeof navigation)[number];
type DemoRole = "patient" | "doctor" | "staff";

export default function App() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [doctorId, setDoctorId] = useState("dr-ananya");
  const [selectedDate, setSelectedDate] = useState(clinicToday);
  const [page, setPage] = useState<Page>("Overview");
  const [role, setRole] = useState<DemoRole>("patient");
  const [query, setQuery] = useState("");
  const [slotChoice, setSlotChoice] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const selectedDoctor = doctors.find((doctor) => doctor.id === doctorId);
  const profile = role === "patient"
    ? { name: PATIENT_NAME, initials: "AS", subtitle: "Patient portal" }
    : role === "doctor"
      ? { name: "Dr. Ananya Rao", initials: "AR", subtitle: "Doctor console" }
      : { name: "Clinic team", initials: "CT", subtitle: "Reception desk" };
  const roleNavigation: Page[] = role === "patient"
    ? [...navigation]
    : role === "doctor"
      ? ["Queue"]
      : ["Appointments", "Queue"];
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => dateOffset(clinicToday(), index)), []);

  const refreshAppointments = useCallback(async () => {
    const filter = role === "patient"
      ? `?patientId=${PATIENT_ID}`
      : role === "doctor"
        ? `?doctorId=${doctorId}`
        : "";
    setAppointments(await request<Appointment[]>(`/appointments${filter}`));
  }, [doctorId, role]);

  const refreshQueue = useCallback(async () => {
    const patient = role === "patient" ? `?patientId=${PATIENT_ID}` : "";
    setQueue(await request<Queue>(`/doctors/${doctorId}/queue${patient}`));
  }, [doctorId, role]);

  const refreshSlots = useCallback(async () => {
    setLoadingSlots(true);
    try {
      setSlots(await request<Slot[]>(`/availability?doctorId=${doctorId}&date=${selectedDate}`));
      setSlotChoice(null);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setLoadingSlots(false);
    }
  }, [doctorId, selectedDate]);

  useEffect(() => {
    let active = true;
    request<Doctor[]>("/doctors")
      .then((items) => {
        if (active) setDoctors(items);
      })
      .catch((error: unknown) => setToast(getErrorMessage(error)))
      .finally(() => {
        if (active) setLoadingDoctors(false);
      });
    refreshAppointments().catch((error: unknown) => setToast(getErrorMessage(error)));
    return () => {
      active = false;
    };
  }, [refreshAppointments]);

  useEffect(() => {
    if (!doctors.length) return;
    refreshSlots();
    refreshQueue().catch((error: unknown) => setToast(getErrorMessage(error)));
  }, [doctorId, doctors.length, refreshQueue, refreshSlots]);

  useEffect(() => {
    const stream = new EventSource(`${API}/api/doctors/${doctorId}/queue/stream`);
    stream.addEventListener("queue-update", () => {
      refreshQueue().catch((error: unknown) => setToast(getErrorMessage(error)));
      refreshAppointments().catch((error: unknown) => setToast(getErrorMessage(error)));
    });
    return () => stream.close();
  }, [doctorId, refreshAppointments, refreshQueue]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredDoctors = doctors.filter((doctor) =>
    `${doctor.name} ${doctor.specialty}`.toLowerCase().includes(query.toLowerCase()),
  );
  const upcomingAppointments = appointments.filter((appointment) =>
    ["BOOKED", "OFFERED", "CHECKED_IN"].includes(appointment.status),
  );
  const doctorQueueAppointments = appointments
    .filter((appointment) =>
      appointment.doctorId === doctorId &&
      clinicToday() === new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(appointment.startsAt)) &&
      ["BOOKED", "CHECKED_IN"].includes(appointment.status),
    )
    .sort((a, b) => a.tokenNumber - b.tokenNumber);
  const completedCount = appointments.filter((appointment) => appointment.status === "COMPLETED").length;
  const offeredAppointment = appointments.find((appointment) => appointment.status === "OFFERED");

  async function bookSlot(slot: Slot, waitlist = false) {
    setBusyAction(true);
    try {
      const appointment = await request<Appointment>(waitlist ? "/waitlist" : "/appointments", {
        method: "POST",
        body: JSON.stringify({
          patientId: PATIENT_ID,
          patientName: PATIENT_NAME,
          doctorId,
          startsAt: slot.startsAt,
        }),
      });
      setSlotChoice(null);
      setToast(waitlist
        ? `You’re on the waitlist for ${formatTime(slot.startsAt)}.`
        : `Appointment confirmed with ${selectedDoctor?.name}.`);
      await Promise.all([refreshAppointments(), refreshQueue(), refreshSlots()]);
      if (appointment.status === "OFFERED") setPage("Appointments");
    } catch (error) {
      setToast(getErrorMessage(error));
      refreshSlots();
    } finally {
      setBusyAction(false);
    }
  }

  async function appointmentAction(id: string, action: "cancel" | "accept" | "check-in") {
    setBusyAction(true);
    try {
      const path = action === "accept" ? `/waitlist/${id}/accept` : `/appointments/${id}/${action}`;
      await request<Appointment | { appointment: Appointment; offered: Appointment | null }>(path, { method: "POST" });
      setToast(action === "cancel" ? "Appointment cancelled. The next patient has been notified." : "Your appointment is updated.");
      await Promise.all([refreshAppointments(), refreshSlots(), refreshQueue()]);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  async function advanceQueue() {
    setBusyAction(true);
    try {
      const completed = await request<Appointment | null>(`/doctors/${doctorId}/queue/complete-next`, { method: "POST" });
      setToast(completed ? `${completed.patientName} marked as seen. Queue updated.` : "No patient is currently being seen.");
      await Promise.all([refreshQueue(), refreshAppointments()]);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setBusyAction(false);
    }
  }

  const nav = (
    <nav className="side-nav" aria-label="Main navigation">
      <span className="nav-label">WORKSPACE</span>
      {roleNavigation.map((item) => (
        <button
          className={`nav-item ${page === item ? "active" : ""}`}
          key={item}
          onClick={() => {
            setPage(item);
            setSidebarOpen(false);
          }}
        >
          {item === "Overview" ? <Activity size={18} /> : item === "Appointments" ? <CalendarDays size={18} /> : <Clock3 size={18} />}
          {item}
          {item === "Appointments" && upcomingAppointments.length > 0 && <span className="nav-count">{upcomingAppointments.length}</span>}
        </button>
      ))}
      <div className="sidebar-bottom">
        <div className="support-card">
          <div className="support-icon"><CircleHelp size={17} /></div>
          <strong>Need a hand?</strong>
          <span>Our care team is here for you.</span>
          <button onClick={() => setToast("Call the clinic at +91 80 4567 8900.")}>Contact support <ArrowRight size={14} /></button>
        </div>
        <div className="sidebar-foot">
          <span className="secure-dot" /> Your health data is private
          <ShieldCheck size={15} />
        </div>
      </div>
    </nav>
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <a className="brand" href="#" onClick={(event) => {
          event.preventDefault();
          setPage(role === "patient" ? "Overview" : role === "doctor" ? "Queue" : "Appointments");
        }}>
          <span className="brand-mark"><Plus size={19} strokeWidth={3} /></span>
          <span>carepoint<span className="brand-period">.</span><small>HEALTH, IN YOUR HANDS</small></span>
        </a>
        <div className="profile-switch">
          <div className="profile-avatar">{profile.initials}</div>
          <div className="profile-switch-details"><strong>{profile.name}</strong><span>{profile.subtitle}</span></div>
          <label className="role-picker"><span>DEMO ROLE</span><select aria-label="Switch demo role" value={role} onChange={(event) => {
            const nextRole = event.target.value as DemoRole;
            setRole(nextRole);
            setPage(nextRole === "patient" ? "Overview" : nextRole === "doctor" ? "Queue" : "Appointments");
          }}><option value="patient">Patient</option><option value="doctor">Doctor</option><option value="staff">Clinic team</option></select></label>
        </div>
        {nav}
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu" />}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle menu"><Menu size={21} /></button>
          <div className="breadcrumb"><span>CarePoint</span><ChevronRight size={14} /><strong>{page}</strong></div>
          <div className="topbar-right">
            <span className="today-label">{new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short" }).format(new Date())}</span>
            <button className="help-button" onClick={() => setToast("For urgent care, call your local emergency number.")}><CircleHelp size={18} /><span>Help</span></button>
            <div className="profile-avatar top-avatar">{profile.initials}</div>
          </div>
        </header>

        <div className="page-content">
          {page === "Overview" && (
            <>
              <section className="welcome-row">
                <div>
                  <div className="eyebrow"><span className="eyebrow-dot" /> YOUR CARE, ALL IN ONE PLACE</div>
                  <h1>A little care goes<br className="desktop-break" /> a long way, <em>Aarav.</em></h1>
                  <p className="welcome-copy">Book your next visit, skip the waiting room guesswork, and stay on top of your health.</p>
                </div>
                <div className="welcome-art" aria-hidden="true">
                  <div className="sun-shape" />
                  <div className="leaf-shape leaf-one" />
                  <div className="leaf-shape leaf-two" />
                  <div className="art-card"><Heart size={20} fill="currentColor" /><span>Wellness<br />starts here</span></div>
                  <Sparkles className="art-sparkle" size={20} />
                </div>
              </section>

              {role === "patient" && offeredAppointment && (
                <section className="offer-banner">
                  <div className="offer-symbol"><Sparkles size={19} /></div>
                  <div><strong>A spot just opened up for you</strong><span>{offeredAppointment.doctorName} · {formatAppointmentDate(offeredAppointment.startsAt)} at {formatTime(offeredAppointment.startsAt)} · offer expires in 10 minutes</span></div>
                  <button disabled={busyAction} onClick={() => appointmentAction(offeredAppointment.id, "accept")}>Accept spot <ArrowRight size={15} /></button>
                </section>
              )}

              <section className="stats-grid" aria-label="Your care at a glance">
                <div className="stat-card">
                  <div className="stat-top"><span className="stat-icon mint-icon"><CalendarDays size={18} /></span><span className="stat-trend"><ArrowUpRight size={14} /> UP TO DATE</span></div>
                  <span className="stat-value">{upcomingAppointments.length.toString().padStart(2, "0")}</span>
                  <span className="stat-name">Upcoming visits</span>
                  <span className="stat-foot">{upcomingAppointments.length ? "Your next steps, all lined up" : "A good time to plan your next check-in"}</span>
                </div>
                <div className="stat-card">
                  <div className="stat-top"><span className="stat-icon lavender-icon"><Heart size={18} /></span><span className="stat-trend neutral"><Activity size={13} /> YOUR JOURNEY</span></div>
                  <span className="stat-value">{completedCount.toString().padStart(2, "0")}</span>
                  <span className="stat-name">Visits completed</span>
                  <span className="stat-foot">Every small step counts</span>
                </div>
                <div className="stat-card stat-card-highlight">
                  <div className="stat-top"><span className="stat-icon peach-icon"><Clock3 size={18} /></span><span className="live-pill"><span /> LIVE QUEUE</span></div>
                  <span className="stat-value">{queue?.myPosition ? `#${queue.myPosition}` : "—"}</span>
                  <span className="stat-name">Your queue position</span>
                  <span className="stat-foot">{queue?.etaMinutes !== null && queue?.etaMinutes !== undefined ? `About ${queue.etaMinutes} min wait · ${queue.doctorName}` : "Book a visit to join the queue"}</span>
                </div>
              </section>

              <section className="booking-section">
                <div className="section-heading">
                  <div><div className="eyebrow">FIND THE RIGHT CARE</div><h2>Book an appointment</h2></div>
                  <div className="timezone-note"><span className="timezone-dot" /> Times in <strong>{TIME_ZONE}</strong></div>
                </div>
                <div className="booking-panel">
                  <div className="booking-controls">
                    <label className="search-field">
                      <Search size={17} />
                      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a doctor or specialty" aria-label="Search doctors" />
                      <kbd>/</kbd>
                    </label>
                    <button className="location-select" onClick={() => setToast("Showing appointments at Indiranagar Clinic.")}>
                      <span className="location-pin"><span /></span>
                      <span><small>CLINIC</small><strong>Indiranagar, Bengaluru</strong></span>
                      <ChevronDown size={16} />
                    </button>
                  </div>
                  <div className="date-picker-heading"><span>Choose a day</span><span>{formatLongDate(selectedDate)}</span></div>
                  <div className="date-strip">
                    {dates.map((date, index) => {
                      const weekday = new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, weekday: "short" }).format(new Date(`${date}T12:00:00Z`));
                      return (
                        <button key={date} className={`date-option ${selectedDate === date ? "date-selected" : ""}`} onClick={() => setSelectedDate(date)}>
                          <span>{index === 0 ? "TODAY" : weekday.toUpperCase()}</span>
                          <strong>{new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, day: "numeric" }).format(new Date(`${date}T12:00:00Z`))}</strong>
                        </button>
                      );
                    })}
                    <button className="calendar-button" onClick={() => setToast("Choose one of the next 7 days to see live availability.")} aria-label="More dates"><CalendarDays size={17} /></button>
                  </div>
                  <div className="booking-divider" />
                  <div className="doctor-results-heading">
                    <div><span className="eyebrow">OUR SPECIALISTS</span><h3>Doctors available <span>{filteredDoctors.length}</span></h3></div>
                    <button className="sort-button" onClick={() => setQuery("")}>All specialties <ChevronDown size={15} /></button>
                  </div>
                  {loadingDoctors ? <div className="empty-state">Finding your care team…</div> : filteredDoctors.length === 0 ? (
                    <div className="empty-state">No doctors match that search. Try another specialty.</div>
                  ) : (
                    <div className="doctor-list">
                      {filteredDoctors.map((doctor) => {
                        const selected = doctor.id === doctorId;
                        const doctorSlots = selected ? slots : [];
                        const availableCount = selected ? doctorSlots.filter((slot) => slot.available).length : null;
                        return (
                          <article className={`doctor-card ${selected ? "doctor-selected" : ""}`} key={doctor.id}>
                            <button className={`doctor-summary ${selected ? "summary-selected" : ""}`} onClick={() => setDoctorId(doctor.id)} aria-expanded={selected}>
                              <span className={`doctor-avatar ${doctor.color}`}>{doctor.initials}<span className="avatar-online" /></span>
                              <span className="doctor-info">
                                <span className="doctor-name">{doctor.name}<span className="verified"><Check size={11} /></span></span>
                                <span className="doctor-specialty">{doctor.specialty} <i /> {doctor.experience} yrs experience</span>
                                <span className="doctor-rating"><span>★</span> {Number(doctor.rating).toFixed(2)} <small> · </small> ₹{Number(doctor.fee).toLocaleString("en-IN")} <small>consultation</small></span>
                              </span>
                              <span className="doctor-action">
                                <span className="availability-count">{selected ? loadingSlots ? "Checking…" : `${availableCount} times` : "View times"}</span>
                                <span className="doctor-chevron">{selected ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
                              </span>
                            </button>
                            {selected && (
                              <div className="slot-area">
                                <div className="slot-area-top">
                                  <span><Clock3 size={14} /> 20-minute visit</span>
                                  <span>Morning <i /> Afternoon</span>
                                </div>
                                {loadingSlots ? <div className="slot-loading">Checking the live schedule…</div> : doctorSlots.length === 0 ? (
                                  <div className="no-slots">No remaining times today. Try another day.</div>
                                ) : (
                                  <div className="slot-grid">
                                    {doctorSlots.map((slot) => (
                                      <button
                                        key={slot.startsAt}
                                        disabled={busyAction}
                                        className={`slot-button ${slotChoice === slot.startsAt ? "slot-chosen" : ""} ${!slot.available ? "slot-full" : ""}`}
                                        onClick={() => slot.available ? setSlotChoice(slot.startsAt) : bookSlot(slot, true)}
                                        title={slot.available ? "Select this appointment time" : "Join the cancellation waitlist"}
                                      >
                                        {slot.available ? formatTime(slot.startsAt) : <>{formatTime(slot.startsAt)} <span className="waitlist-mark">· waitlist</span></>}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {slotChoice && selectedDoctor?.id === doctor.id && (
                                  <div className="booking-confirm">
                                    <span><CheckCircle2 size={17} /> {formatLongDate(selectedDate)} at {formatTime(slotChoice)}</span>
                                    <button disabled={busyAction} onClick={() => {
                                      const slot = doctorSlots.find((item) => item.startsAt === slotChoice);
                                      if (slot) bookSlot(slot);
                                    }}>{busyAction ? "Booking…" : "Confirm booking"} <ArrowRight size={15} /></button>
                                  </div>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <div className="booking-footnote"><ShieldCheck size={15} /> Your appointment details are encrypted and only shared with your care team.</div>
                </div>
              </section>

              <section className="bottom-grid">
                <div className="queue-card">
                  <div className="queue-card-heading"><div><span className="eyebrow">NO MORE GUESSING</span><h3>Clinic, in real time</h3></div><span className="live-pill"><span /> LIVE</span></div>
                  <p>Dr. Ananya's queue updates as patients are seen.</p>
                  <div className="queue-track">
                    <div className="queue-number">{queue?.currentToken ? `#${queue.currentToken}` : "—"}<span>NOW SERVING</span></div>
                    <div className="queue-line"><span /></div>
                    <div className="queue-number">{queue?.waitingCount ?? "—"}<span>WAITING</span></div>
                    <div className="queue-number wait-estimate">{queue?.averageConsultMinutes ?? "—"}<span>MIN AVG.</span></div>
                  </div>
                  <div className="queue-card-footer"><span><span className="queue-indicator" /> Position refreshes automatically</span><button onClick={() => setPage("Queue")}>View queue <ArrowRight size={14} /></button></div>
                </div>
                <div className="care-note">
                  <div className="care-note-top"><span className="care-note-icon"><Heart size={17} /></span><span>YOUR CARE NOTE</span><MoreHorizontal size={19} /></div>
                  <h3>Good health is a journey, not a destination.</h3>
                  <p>Small, regular check-ins can make a big difference. Your care team is here whenever you need them.</p>
                  <button onClick={() => { setPage("Appointments"); }}>Explore your visits <ArrowRight size={14} /></button>
                  <div className="care-note-decoration"><span /><span /><span /></div>
                </div>
              </section>
              <footer className="page-footer"><span>CarePoint <span className="brand-period">·</span> Thoughtful healthcare, closer to you.</span><span><ShieldCheck size={14} /> Secure by design</span></footer>
            </>
          )}

          {page === "Appointments" && (
            <section className="subpage">
              <div className="subpage-title"><div className="eyebrow">{role === "staff" ? "FRONT DESK" : "YOUR CARE PLAN"}</div><h1>{role === "staff" ? "Clinic appointments" : "Appointments"}</h1><p>{role === "staff" ? "Review the clinic schedule and check patients in." : "All your upcoming visits and waitlist offers, in one place."}</p></div>
              {role === "patient" && offeredAppointment && (
                <div className="offer-banner subpage-offer">
                  <div className="offer-symbol"><Sparkles size={19} /></div>
                  <div><strong>A spot just opened up for you</strong><span>{offeredAppointment.doctorName} · {formatAppointmentDate(offeredAppointment.startsAt)} at {formatTime(offeredAppointment.startsAt)}</span></div>
                  <button disabled={busyAction} onClick={() => appointmentAction(offeredAppointment.id, "accept")}>Accept spot <ArrowRight size={15} /></button>
                </div>
              )}
              <div className="appointment-list">
                {appointments.length === 0 ? <div className="empty-card"><CalendarDays size={26} /><h3>{role === "staff" ? "No appointments to show." : "Your next chapter starts here."}</h3><p>{role === "staff" ? "New clinic bookings will appear here." : "Book a visit with one of our specialists to get started."}</p>{role === "patient" && <button className="primary-button" onClick={() => setPage("Overview")}>Find a doctor <ArrowRight size={15} /></button>}</div> :
                  appointments.map((appointment) => (
                    <article className="appointment-card" key={appointment.id}>
                      <div className="appointment-date-block"><span>{formatAppointmentDate(appointment.startsAt).split(",")[0]}</span><strong>{new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, day: "2-digit" }).format(new Date(appointment.startsAt))}</strong><small>{new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, month: "short" }).format(new Date(appointment.startsAt)).toUpperCase()}</small></div>
                      <div className="appointment-detail"><span className="appointment-specialty">{doctors.find((doctor) => doctor.id === appointment.doctorId)?.specialty || "Clinic visit"}</span><h3>{appointment.doctorName}</h3><span><Clock3 size={14} /> {formatTime(appointment.startsAt)} <i /> Token #{appointment.tokenNumber}</span></div>
                      <span className={`status-pill status-${appointment.status.toLowerCase()}`}>{appointment.status.replace("_", " ")}</span>
                      <div className="appointment-actions">
                        {role === "patient" && appointment.status === "OFFERED" && <button className="accept-button" disabled={busyAction} onClick={() => appointmentAction(appointment.id, "accept")}>Accept offer</button>}
                        {appointment.status === "BOOKED" && <button className="text-button" disabled={busyAction} onClick={() => appointmentAction(appointment.id, "check-in")}>Check in</button>}
                        {["BOOKED", "OFFERED"].includes(appointment.status) && role !== "doctor" && <button className="cancel-button" disabled={busyAction} onClick={() => appointmentAction(appointment.id, "cancel")}>Cancel</button>}
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          )}

          {page === "Queue" && (
            <section className="subpage queue-page">
              <div className="subpage-title"><div className="eyebrow">{role === "doctor" ? "DOCTOR CONSOLE" : role === "staff" ? "FRONT DESK" : "A BETTER WAITING ROOM"}</div><h1>{role === "doctor" ? "Today’s patient queue" : "Live clinic queue"}</h1><p>{role === "doctor" ? "Follow patient tokens and advance the queue as consultations finish." : "Follow the flow in real time. Your position updates automatically as patients are seen."}</p></div>
              <div className="queue-live-card">
                <div className="queue-live-top"><div className="doctor-avatar lavender">{selectedDoctor?.initials ?? "AR"}<span className="avatar-online" /></div><div><span className="eyebrow">NOW AT THE CLINIC</span><h2>{queue?.doctorName ?? "Loading queue…"}</h2><p>{new Intl.DateTimeFormat("en-IN", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" }).format(new Date())} · Indiranagar, Bengaluru</p></div><span className="live-pill"><span /> LIVE UPDATES</span></div>
                <div className="queue-live-metrics"><div><span className="queue-big-number">{role === "patient" ? (queue?.myPosition ? `#${queue.myPosition}` : "—") : (queue?.waitingCount ?? "—")}</span><span>{role === "patient" ? "YOUR POSITION" : "WAITING NOW"}</span></div><div><span className="queue-big-number">{role === "patient" ? (queue?.etaMinutes ?? "—") : (queue?.averageConsultMinutes ?? "—")}<small> min</small></span><span>{role === "patient" ? "ESTIMATED WAIT" : "AVG. CONSULT"}</span></div><div><span className="queue-big-number">#{queue?.currentToken || "—"}</span><span>NOW SERVING</span></div><div><span className="queue-big-number">{queue?.waitingCount ?? "—"}</span><span>IN THE QUEUE</span></div></div>
                <div className="queue-estimate-note"><Activity size={16} /><span>Wait estimate is based on Dr. {queue?.doctorName?.replace("Dr. ", "") ?? "Ananya Rao"}’s rolling average of <strong>{queue?.averageConsultMinutes ?? "—"} minutes</strong> per consultation.</span></div>
                <div className="queue-progress"><span className="progress-label">{role === "patient" ? "QUEUE PROGRESS" : "CLINIC PROGRESS"} <strong>{role === "patient" ? (queue?.myPosition ? `You’re ${queue.myPosition} ${queue.myPosition === 1 ? "patient" : "patients"} away` : "No active visit") : `${queue?.waitingCount ?? 0} ${queue?.waitingCount === 1 ? "patient is" : "patients are"} waiting`}</strong></span><div className="progress-track"><span style={{ width: `${role === "patient" && queue?.myPosition ? Math.max(12, 100 / (queue.myPosition + 1)) : queue?.waitingCount ? 68 : 0}%` }} /></div><div className="progress-caption"><span>Now serving #{queue?.currentToken || "—"}</span><span>{role === "patient" ? `Your token is ${appointments.find((appointment) => appointment.doctorId === doctorId && ["BOOKED", "CHECKED_IN"].includes(appointment.status)) ? `#${appointments.find((appointment) => appointment.doctorId === doctorId && ["BOOKED", "CHECKED_IN"].includes(appointment.status))?.tokenNumber}` : "not booked yet"}` : "Token board is up to date"}</span></div></div>
                <div className="queue-demo-controls"><span><span className="queue-indicator" /> Connected to live updates via server-sent events</span>{role === "doctor" && <button className="text-button" disabled={busyAction} onClick={advanceQueue}>Mark current patient seen <ArrowRight size={14} /></button>}</div>
              </div>
              {role === "doctor" && <div className="doctor-queue-list"><div className="doctor-queue-list-heading"><div><span className="eyebrow">TOKEN BOARD</span><h2>Today’s appointments <span>{doctorQueueAppointments.length}</span></h2></div><span className="live-pill"><span /> LIVE</span></div>{doctorQueueAppointments.length === 0 ? <div className="empty-state">No patients are booked in today’s queue.</div> : doctorQueueAppointments.map((appointment) => <div className="doctor-queue-row" key={appointment.id}><span className="token-chip">#{appointment.tokenNumber}</span><div><strong>{appointment.patientName}</strong><span>{formatTime(appointment.startsAt)} · {appointment.status === "CHECKED_IN" ? "In consultation" : "Waiting"}</span></div><span className={`status-pill status-${appointment.status.toLowerCase()}`}>{appointment.status.replace("_", " ")}</span></div>)}</div>}
              <div className="timezone-banner"><ShieldCheck size={17} /><span>Appointment times and queue dates are shown in the clinic’s <strong>{TIME_ZONE}</strong> time zone, wherever you’re connecting from.</span></div>
            </section>
          )}
        </div>
      </main>
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </div>
  );
}
