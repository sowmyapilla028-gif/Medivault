// The follow-up agent. Phase 1 (plan) decides whether a specialist visit is needed and, if so, finds times.
// It stops for the patient's approval. Phase 2 (book) runs only after the patient picks a time.
import { triage as runTriage } from "./triage.js";
import { CLINICS, buildEmails, callScript, clinicSlots, makeAppointment, newConfirmation, planWindow, proposeSlots, sampleCalendar } from "./scheduling.js";

const fmtDate = (d) => new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export function patientFrom(document, record, epicPatient) {
  return {
    name: document?.patientName || epicPatient?.name || "the patient",
    birthDate: document?.birthDate || epicPatient?.birthDate || null,
  };
}

/** Phase 1. Yields events; returns the final agent state. */
export async function* plan({ record, document, patient, wait }) {
  const state = { status: "planning", steps: [], createdAt: new Date().toISOString() };
  const step = (id, title, detail = "", status = "done") => {
    const s = { id, title, detail, status };
    const i = state.steps.findIndex((x) => x.id === id);
    if (i >= 0) state.steps[i] = s; else state.steps.push(s);
    return { type: "step", step: s };
  };

  yield step("triage", "Reviewing your new results against your history", "", "running");
  await wait(700);
  const t = runTriage(record, document);
  state.triage = t;
  if (!t.needed) {
    state.status = "not_needed";
    yield step("triage", "No specialist follow-up needed", t.reason);
    yield { type: "state", state };
    return state;
  }
  const f = t.primary;
  yield step("triage", `${f.specialty} follow-up needed within ${f.windowDays[0]}–${f.windowDays[1]} days`, `${f.reason} Rule: ${f.criterion}.`);
  yield { type: "alert", followUp: f, others: t.others };

  const win = planWindow(f.windowDays);
  yield step("calendar", "Checking your calendar", "", "running");
  await wait(800);
  const events = sampleCalendar(win.calendarFrom, win.to);
  state.calendar = { from: win.calendarFrom.toISOString(), to: win.to.toISOString(), windowStart: win.from.toISOString(), events: events.map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() })), sample: true };
  yield step("calendar", "Checked your calendar", `${events.length} events between ${fmtDate(win.from)} and ${fmtDate(win.to)} (sample calendar)`);
  yield { type: "calendar", calendar: state.calendar };

  yield step("search", `Finding ${f.specialistTitle.toLowerCase()} availability`, "", "running");
  await wait(900);
  let clinic = null, proposals = [];
  for (const c of CLINICS[f.specialty] || []) {
    proposals = proposeSlots(clinicSlots(c, win.from, win.to), events, win.from);
    if (proposals.length) { clinic = c; break; }
  }
  if (!clinic) {
    state.status = "no_slots";
    yield step("search", "No matching times found", `No ${f.specialty.toLowerCase()} openings fit your calendar in this window. Call your primary care office for a referral.`, "error");
    yield { type: "state", state };
    return state;
  }
  state.clinic = clinic;
  state.proposals = proposals.map((s) => ({ id: s.id, start: s.start.toISOString(), end: s.end.toISOString(), provider: clinic.provider }));
  yield step("search", `Found ${proposals.length} times that fit your calendar`, `${clinic.provider} · ${clinic.name} · ${clinic.distance} · accepts Medicare`);
  yield step("approve", "Waiting for you to pick a time", "Nothing is booked or sent until you approve.", "waiting");
  state.status = "awaiting_approval";
  state.patient = patient;
  yield { type: "state", state };
  return state;
}

/** Phase 2, after approval. */
export async function* book({ state, slotId, record, patientEmail, wait }) {
  const proposal = state.proposals?.find((p) => p.id === slotId);
  if (state.status !== "awaiting_approval" || !proposal) throw Object.assign(new Error("That time is no longer available. Run the agent again."), { status: 409 });
  const f = state.triage.primary, clinic = state.clinic, patient = state.patient;
  const slot = { id: proposal.id, start: new Date(proposal.start), end: new Date(proposal.end) };
  const step = (id, title, detail = "", status = "done") => {
    const s = { id, title, detail, status };
    const i = state.steps.findIndex((x) => x.id === id);
    if (i >= 0) state.steps[i] = s; else state.steps.push(s);
    return { type: "step", step: s };
  };
  state.status = "booking";
  yield step("approve", "You approved a time", `${fmtDate(slot.start)}, ${slot.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);

  const confirmation = newConfirmation();
  yield step("call", `Calling ${clinic.name}`, `${clinic.phone} · simulated call`, "running");
  const lines = callScript({ patient, clinic, followUp: f, slot, confirmation });
  state.call = { clinic: clinic.name, phone: clinic.phone, simulated: true, transcript: [] };
  for (const line of lines) {
    await wait(line.speaker === "clinic" ? 900 : 700);
    state.call.transcript.push(line);
    yield { type: "transcript", line };
  }
  state.call.outcome = `Booked · confirmation ${confirmation}`;
  yield step("call", `Booked with ${clinic.provider}`, `Confirmation ${confirmation}`);

  state.appointment = makeAppointment({ patient, clinic, followUp: f, slot, confirmation });
  yield step("calendar-add", "Added to your calendar", "Download the invite to add it to Google, Outlook or Apple Calendar.");
  yield { type: "appointment", appointment: state.appointment };
  await wait(400);

  state.emails = buildEmails({ patient, patientEmail, clinic, followUp: f, slot, confirmation, record, triage: state.triage })
    .map((e) => ({ ...e, sentAt: new Date().toISOString(), status: "Sent (demo outbox)" }));
  yield step("email", "Emailed you and the specialist's office", "Booking confirmation to you; pre-visit summary and questions to the office.");
  yield { type: "emails", emails: state.emails };
  state.status = "booked";
  yield { type: "state", state };
  return state;
}
