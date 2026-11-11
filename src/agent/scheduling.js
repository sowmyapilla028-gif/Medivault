// Calendar, specialist directory, slot matching, call script, emails and .ics for the follow-up agent.
// The calendar and clinics are simulated for the demo; the shapes follow FHIR Slot/Appointment so a real
// scheduling API can replace them.
import crypto from "node:crypto";

const hash = (s) => crypto.createHash("sha256").update(s).digest().readUInt32BE(0);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (dateStr, h, m = 0) => { const [y, mo, d] = dateStr.split("-").map(Number); return new Date(y, mo - 1, d, h, m); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const overlaps = (a, b, bufferMin = 0) => a.start < new Date(b.end.getTime() + bufferMin * 60000) && new Date(a.end.getTime() + bufferMin * 60000) > b.start;

export const CLINICS = {
  Endocrinology: [
    { id: "valley-endo", name: "Valley Endocrinology & Diabetes Center", provider: "Dr. Priya Raman, MD", address: "2140 Alder Street, Suite 300", phone: "(555) 014-2290", email: "scheduling@valley-endo.example", distance: "3.2 mi", acceptsMedicare: true },
    { id: "riverside-diabetes", name: "Riverside Diabetes Clinic", provider: "Dr. Marcus Hale, MD", address: "88 Riverside Drive", phone: "(555) 014-7712", email: "frontdesk@riverside-diabetes.example", distance: "6.8 mi", acceptsMedicare: true },
  ],
  Nephrology: [
    { id: "lakeside-kidney", name: "Lakeside Kidney Care", provider: "Dr. Elena Ortiz, MD", address: "455 Lakeside Ave", phone: "(555) 014-3301", email: "appointments@lakeside-kidney.example", distance: "4.1 mi", acceptsMedicare: true },
  ],
  Cardiology: [
    { id: "heartwell-lipid", name: "Heartwell Lipid Clinic", provider: "Dr. Samuel Okafor, MD", address: "12 Harbor Plaza", phone: "(555) 014-5580", email: "care@heartwell.example", distance: "5.0 mi", acceptsMedicare: true },
  ],
};

/** Sample patient calendar (deterministic per date) between two dates. */
export function sampleCalendar(fromDate, toDate) {
  const events = [];
  for (let d = new Date(fromDate); d <= toDate; d = addDays(d, 1)) {
    const day = d.getDay(), key = ymd(d), h = hash(`cal-${key}`);
    if (day === 0 || day === 6) {
      if (h % 3 === 0) events.push({ title: "Family lunch", start: at(key, 12), end: at(key, 14) });
      continue;
    }
    if (day === 1 || day === 3 || day === 5) events.push({ title: "Work: focus block", start: at(key, 9), end: at(key, 12) });
    else events.push({ title: "Team stand-up", start: at(key, 9), end: at(key, 9, 30) });
    if (h % 4 === 0) events.push({ title: "Client call", start: at(key, 14), end: at(key, 15) });
    if (h % 5 === 1) events.push({ title: "Pick up grandkids", start: at(key, 15, 30), end: at(key, 17) });
    if (day === 3) events.push({ title: "Yoga class", start: at(key, 17, 30), end: at(key, 18, 30) });
  }
  return events;
}

/** Open slots (FHIR Slot-shaped) for a clinic between two dates. */
export function clinicSlots(clinic, fromDate, toDate) {
  const slots = [];
  for (let d = new Date(fromDate); d <= toDate; d = addDays(d, 1)) {
    const day = d.getDay(); if (day === 0 || day === 6) continue;
    const key = ymd(d);
    for (let mins = 8 * 60; mins <= 16 * 60; mins += 30) {
      if (mins >= 12 * 60 && mins < 13 * 60) continue; // clinic lunch
      if (hash(`${clinic.id}-${key}-${mins}`) % 6 !== 0) continue; // ~1 in 6 open
      const start = at(key, Math.floor(mins / 60), mins % 60);
      slots.push({ resourceType: "Slot", id: `${clinic.id}-${key}-${mins}`, status: "free", start, end: new Date(start.getTime() + 40 * 60000),
        serviceType: [{ text: "New patient consultation" }], schedule: { display: `${clinic.provider} at ${clinic.name}` } });
    }
  }
  return slots;
}

/** Pick up to 3 slots that avoid the patient's events (with 45 min travel buffer), on different days, earliest first. */
export function proposeSlots(slots, events, earliest) {
  const ok = slots.filter((s) => s.start >= earliest && !events.some((e) => overlaps({ start: s.start, end: s.end }, e, 45)))
    .sort((a, b) => a.start - b.start);
  const picked = [], days = new Set();
  for (const s of ok) {
    const k = ymd(s.start);
    if (days.has(k)) continue;
    days.add(k); picked.push(s);
    if (picked.length === 3) break;
  }
  return picked;
}

export function planWindow(windowDays, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: addDays(today, windowDays[0]), to: addDays(today, windowDays[1]), calendarFrom: addDays(today, Math.max(0, windowDays[0] - 2)) };
}

const fmtWhen = (d) => d.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Simulated phone call: the agent identifies itself as an AI assistant acting for the patient. */
export function callScript({ patient, clinic, followUp, slot, confirmation }) {
  const when = fmtWhen(slot.start);
  return [
    { speaker: "clinic", text: `${clinic.name}, this is Dana speaking. How can I help?` },
    { speaker: "agent", text: `Hi Dana. I'm Medivault, an AI assistant calling on behalf of ${patient.name}, with their permission. I'd like to book a new-patient visit with ${clinic.provider}.` },
    { speaker: "clinic", text: "Sure. What's the reason for the visit?" },
    { speaker: "agent", text: `${followUp.reason} Their records suggest being seen within ${followUp.windowDays[0]} to ${followUp.windowDays[1]} days.` },
    { speaker: "clinic", text: "Okay. Date of birth and insurance?" },
    { speaker: "agent", text: `Date of birth ${patient.birthDate || "on file"}. Insurance is Medicare, with Part D.` },
    { speaker: "clinic", text: `We take Medicare. I have ${when} open.` },
    { speaker: "agent", text: `That works with their calendar. Please book ${when}.` },
    { speaker: "clinic", text: `Done. Confirmation number ${confirmation}. Please arrive 15 minutes early and bring a medication list and recent lab results.` },
    { speaker: "agent", text: "Thank you. I'll send the office a short pre-visit summary by email so the doctor has the context. Goodbye." },
  ];
}

export function makeAppointment({ patient, clinic, followUp, slot, confirmation }) {
  return {
    resourceType: "Appointment", id: `appt-${confirmation}`, status: "booked",
    serviceCategory: [{ text: followUp.specialty }], serviceType: [{ text: "New patient consultation" }],
    reasonCode: [{ text: followUp.reason }], start: slot.start.toISOString(), end: slot.end.toISOString(),
    slot: [{ reference: `Slot/${slot.id}` }], identifier: [{ system: "clinic-confirmation", value: confirmation }],
    participant: [{ actor: { display: patient.name }, status: "accepted" }, { actor: { display: clinic.provider }, status: "accepted" }, { actor: { display: clinic.name } }],
    description: `${followUp.specialty} follow-up at ${clinic.name}`,
  };
}

export function buildEmails({ patient, patientEmail, clinic, followUp, slot, confirmation, record, triage }) {
  const when = fmtWhen(slot.start);
  const srcName = { document: "uploaded lab report", epic: "health record", cms: "pharmacy claims" };
  const evidenceLines = followUp.evidence.map((e) => `- ${e.detail} (${srcName[e.source] || e.source})`).join("\n");
  const others = triage.others?.length ? `\nAlso worth raising: ${triage.others.map((o) => `${o.specialty} (${o.criterion.toLowerCase()})`).join("; ")}.\n` : "";
  const meds = record.medications.filter((m) => !m.oneTime).map((m) => `- ${m.label}: last filled ${m.lastFill}, ${m.status === "lapsed" ? `ran out ${m.daysWithoutSupply} days ago` : "supply current"}`).join("\n");
  return [
    {
      id: "to-patient", to: patientEmail || `${patient.name} (your inbox)`, from: "Medivault care agent <agent@medivault.example>",
      subject: `Action needed: ${followUp.specialty} follow-up booked for ${slot.start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      body: `Hi ${patient.name.split(" ")[0]},

Your new lab results need a follow-up with a specialist.

Why: ${followUp.reason}
Rule that triggered this: ${followUp.criterion}.

What I did
- Checked your calendar for times you're free in the next ${followUp.windowDays[0]}-${followUp.windowDays[1]} days
- Called ${clinic.name} and booked the time you approved
- Sent the office a short summary so the doctor has context

Your appointment
${when}
${clinic.provider}, ${clinic.name}
${clinic.address} · ${clinic.phone}
Confirmation number: ${confirmation}

Bring
- Your medication list (including anything you stopped taking)
- Your latest lab report
- Your Medicare card

Questions to ask
${followUp.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}
${others}
The calendar invite is attached. Reply to this email if you need to change the time.

Medivault care agent
This is decision support, not medical advice.`,
      attachments: ["appointment.ics"],
    },
    {
      id: "to-specialist", to: `${clinic.name} <${clinic.email}>`, from: `Medivault on behalf of ${patient.name} <agent@medivault.example>`,
      subject: `Pre-visit summary: ${patient.name}, ${when} (conf. ${confirmation})`,
      body: `Hello ${clinic.name} team,

Ahead of ${patient.name}'s new-patient visit with ${clinic.provider} on ${when} (confirmation ${confirmation}), here is a short summary the patient asked us to share.

Patient: ${patient.name}${patient.birthDate ? `, DOB ${patient.birthDate}` : ""}
Reason for referral: ${followUp.reason}

Key findings
${evidenceLines}

Medication fills (Medicare Part D claims)
${meds || "- None on file"}

Questions the patient would like to discuss
${followUp.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Shared with the patient's consent through Medivault. Sources: ${[...new Set(record.facts.map((f) => srcName[f.source]))].join(", ")}.

Thank you,
Medivault care agent`,
      attachments: followUp.share.map((s) => `${s}.pdf`),
    },
  ];
}

const icsDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
export function toIcs(appt, clinic, followUp, questions) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Medivault//Care agent//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${appt.id}@medivault`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(new Date(appt.start))}`, `DTEND:${icsDate(new Date(appt.end))}`,
    `SUMMARY:${icsText(`${followUp.specialty}: ${clinic.provider}`)}`,
    `LOCATION:${icsText(`${clinic.name}, ${clinic.address}`)}`,
    `DESCRIPTION:${icsText(`${followUp.reason}\nConfirmation ${appt.identifier[0].value}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`)}`,
    "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Specialist appointment in 2 hours", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

export const newConfirmation = () => `VE-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
