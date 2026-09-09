// License number attribute type doesn't exist in config yet (no ProviderAttributeType
// for it) — hardcoded until that's added; see EncounterPrescriptionPlan.md.
const LICENSE_NUMBER_PLACEHOLDER = '-';

module.exports = {
  compute: async function ({ context, resolved, ValidationError }) {
    if (!context?.patientUUID) throw new ValidationError('patientUUID is required');
    if (!context?.encounterUuid) throw new ValidationError('encounterUuid is required');

    // "patient" is fetched with _revinclude=AllergyIntolerance:patient, so the bundle
    // carries both resource types — split them out instead of two separate calls.
    const patientBundleResources = (resolved?.patient?.entry ?? []).map((e) => e.resource).filter(Boolean);
    const patient = patientBundleResources.find((r) => r.resourceType === 'Patient');
    const allergyResources = patientBundleResources.filter((r) => r.resourceType === 'AllergyIntolerance');

    const officialId = patient?.identifier?.find((id) => id.use === 'official');
    const address = patient?.address?.[0];
    // fetched as a direct Practitioner/{id} read (not a search) — Practitioner?_id= on this
    // server's FHIR2 build ignores the _id filter and returns every practitioner, so a search
    // bundle can't be trusted here the way it can for Patient.
    const provider = resolved?.providerPractitioner;
    return {
      patientName: patient?.name?.[0]?.text ?? '',
      patientId: officialId?.value ?? '',
      birthDate: patient?.birthDate ?? '',
      gender: patient?.gender ?? '',
      address: buildAddress(address),

      allergies: buildAllergies(allergyResources),
      conditions: buildConditions(resolved?.conditions),
      diagnoses: buildDiagnoses(resolved?.diagnoses, context.encounterUuid),
      chiefComplaints: buildChiefComplaints(resolved?.chiefComplaintObs),
      medications: buildMedications(resolved?.medicationRequests),
      investigations: buildInvestigations(resolved?.investigations),
      vitals: buildVitals(resolved?.vitals),

      providerName: provider?.name?.[0]?.text ?? '',
      providerLicenseNumber: LICENSE_NUMBER_PLACEHOLDER,
    };
  },
};

function refId(reference) {
  return reference?.split('/')?.[1] ?? '';
}

// Same composed-address pattern as print-templates/registration-card/compute.js: house
// number/locality live in a nested OpenMRS address extension (not plain FHIR Address
// fields), so they have to be pulled out separately before joining with city/district/
// state/postalCode into one comma-separated string.
const ADDRESS_EXT = 'http://fhir.openmrs.org/ext/address';

function addressExtField(address, field) {
  const wrapper = (address?.extension ?? []).find((e) => e.url === ADDRESS_EXT);
  return (wrapper?.extension ?? []).find((e) => e.url === `${ADDRESS_EXT}#${field}`)?.valueString ?? '';
}

function buildAddress(address) {
  const houseNumber = addressExtField(address, 'address1');
  const locality = addressExtField(address, 'address2');
  const composed = [houseNumber, locality, address?.city, address?.district, address?.state, address?.postalCode]
    .filter(Boolean)
    .join(', ');
  return composed || (address?.text ?? '');
}

function buildAllergies(resources) {
  return (resources ?? [])
    .map((a) => ({
      allergen: a.code?.text ?? a.code?.coding?.[0]?.display ?? '',
      // reaction[].severity (mild/moderate/severe) is the clinical severity;
      // criticality (low/high/unable-to-assess) is a different field and only
      // used as a fallback when no reaction severity is recorded.
      severity: a.reaction?.find((r) => r.severity)?.severity ?? a.criticality ?? '',
      reactions: (a.reaction ?? [])
        .flatMap((r) => (r.manifestation ?? []).map((m) => m.text ?? m.coding?.[0]?.display ?? ''))
        .filter(Boolean),
      recordedBy: a.recorder?.display ?? '',
      recordedDate: a.recordedDate ?? '',
    }));
}

function buildConditions(bundle) {
  return (bundle?.entry ?? [])
    .map((e) => e.resource)
    .filter(Boolean)
    .map((c) => ({
      name: c.code?.text ?? c.code?.coding?.[0]?.display ?? '',
      onsetDate: c.onsetDateTime ?? '',
      recordedBy: c.recorder?.display ?? '',
      note: (c.note ?? []).map((n) => n.text).filter(Boolean).join('; '),
    }));
}

// resolved.diagnoses is a FHIR Condition Bundle filtered server-side to
// category=encounter-diagnosis; certainty comes from verificationStatus
// (confirmed/provisional), not a bahmnicore "certainty" field. FHIR Condition
// has no primary/secondary "order" field, so that column is dropped.
function buildDiagnoses(bundle, encounterUuid) {
  return (bundle?.entry ?? [])
    .map((e) => e.resource)
    .filter((d) => d && refId(d.encounter?.reference) === encounterUuid)
    .map((d) => ({
      name: d.code?.text ?? d.code?.coding?.[0]?.display ?? '',
      certainty: d.verificationStatus?.coding?.[0]?.display ?? d.verificationStatus?.coding?.[0]?.code ?? '',
      recordedDate: d.recordedDate ?? '',
      note: (d.note ?? []).map((n) => n.text).filter(Boolean).join('; '),
    }));
}

// chiefComplaintObs is fetched scoped to the "Chief Complaint Record" obs-group concept
// (code=<its fixed UUID, pinned in standard-config/masterdata/configuration/concepts/
// FormConcepts.csv> ) with _include=Observation:has-member, so the bundle is just the
// group observation(s) for this encounter plus their member observations — no broad
// per-encounter fetch or client-side name-matching across unrelated obs needed.
function buildChiefComplaints(bundle) {
  const resources = (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
  const byId = new Map(resources.map((o) => [o.id, o]));
  const groups = resources.filter((o) => Array.isArray(o.hasMember) && o.hasMember.length > 0);

  // Observation.performer is not populated by this server's FHIR2 module for these obs
  // (verified null, even though obs.creator is set in the DB) — "recorded by" can't be
  // sourced from this call; the Provider Details section already covers who's printing.
  return groups
    .map((group) => {
      const members = (group.hasMember ?? [])
        .map((ref) => byId.get(refId(ref.reference)))
        .filter(Boolean);
      const coded = members.find((m) => m.code?.text === 'Chief Complaint Coded');
      const freeText = members.find((m) => m.code?.text === 'Chief complaint (text)');
      const durationValue = members.find((m) => m.code?.text === 'Sign/symptom duration');
      const durationUnit = members.find((m) => m.code?.text === 'Chief Complaint Duration');

      // Coded and free-text are two separate capture fields (not one-or-the-other) —
      // the form lets a user pick a coded complaint and still add free-text notes, so
      // show both whenever both are recorded instead of dropping one.
      const complaint = coded?.valueCodeableConcept?.text ?? '';
      const notes = freeText?.valueString ?? '';
      const duration =
        durationValue?.valueQuantity?.value != null && durationUnit?.valueCodeableConcept?.text
          ? `${durationValue.valueQuantity.value} ${durationUnit.valueCodeableConcept.text}`
          : '';

      return { complaint: complaint || notes, notes: complaint && notes ? notes : '', duration };
    })
    .filter((c) => c.complaint);
}

function buildMedications(bundle) {
  const entries = bundle?.entry ?? [];
  const medicationResources = entries.filter((e) => e.resource?.resourceType === 'Medication').map((e) => e.resource);
  const medicationMap = new Map(
    medicationResources.map((m) => [m.id, m.form?.text ?? m.form?.coding?.[0]?.display ?? '']),
  );
  const medicationRequests = entries.filter((e) => e.resource?.resourceType === 'MedicationRequest').map((e) => e.resource);

  return medicationRequests
    .filter((mr) => ['active', 'on-hold'].includes(mr.status))
    .map((mr) => {
      const baseName = mr.medicationCodeableConcept?.text ?? mr.medicationReference?.display ?? '';
      const dosageForm = medicationMap.get(refId(mr.medicationReference?.reference)) ?? '';
      const d = mr.dosageInstruction?.[0];
      const priority = mr.priority === 'stat' ? 'STAT' : d?.asNeededBoolean ? 'PRN' : '';

      return {
        drugName: dosageForm ? `${baseName} (${dosageForm})` : baseName,
        dosageInstructions: buildDosageInstructions(mr.dosageInstruction),
        startDate: d?.timing?.event?.[0] ?? mr.authoredOn ?? '',
        treatmentNotes: parseAdditionalInstructions(d?.text) || mr.note?.[0]?.text || '',
        priority,
      };
    });
}

// Combines dose/frequency/free-text instructions/SOS/route/duration into one display
// string, matching prescriptions/compute.js's buildDosageInstructions so both templates
// render medications the same way.
function buildDosageInstructions(dosageInstruction) {
  const d = dosageInstruction?.[0];
  if (!d) return '';

  const parts = [];
  const doseQty = d.doseAndRate?.[0]?.doseQuantity;
  if (doseQty?.value != null) parts.push(`${doseQty.value} ${doseQty.unit ?? ''}`.trim());

  const frequency = d.timing?.code?.text;
  if (frequency) parts.push(frequency);

  const instructions = parseInstructions(d.text);
  if (instructions) parts.push(instructions);

  if (d.asNeededBoolean) parts.push('SOS');

  const route = d.route?.text;
  if (route) parts.push(route);

  const repeat = d.timing?.repeat;
  if (repeat?.duration != null) {
    return `${parts.join(', ')} - ${repeat.duration} ${durationLabel(repeat.durationUnit)}`;
  }
  return parts.join(', ');
}

function parseInstructions(text) {
  if (!text) return '';
  try {
    const instr = JSON.parse(text)?.instructions ?? '';
    return instr.toLowerCase() === 'as directed' ? '' : instr;
  } catch {
    return text;
  }
}

// additionalInstructions is a separate field from instructions within the same JSON
// blob — surfaced as "Treatment Notes" below the drug row, same as prescriptions/.
function parseAdditionalInstructions(text) {
  if (!text) return '';
  try {
    return JSON.parse(text)?.additionalInstructions ?? '';
  } catch {
    return '';
  }
}

function durationLabel(code) {
  const map = { s: 'Seconds', min: 'Minutes', h: 'Hours', d: 'Days', wk: 'Weeks', mo: 'Months', a: 'Years' };
  return map[code] ?? code ?? '';
}

// Grouped by order type (category), read dynamically from whatever categories the
// response actually contains — no hardcoded order-type list, and a ServiceRequest with
// no category is dropped rather than bucketed into a synthetic "Other" group, since
// there's no order-type section to show it under.
function buildInvestigations(bundle) {
  const requests = (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);

  const groups = new Map();
  for (const sr of requests) {
    const orderType = sr.category?.[0]?.text ?? sr.category?.[0]?.coding?.[0]?.display ?? '';
    if (!orderType) continue;

    if (!groups.has(orderType)) groups.set(orderType, []);
    groups.get(orderType).push({
      name: sr.code?.text ?? sr.code?.coding?.[0]?.display ?? '',
      // meta.lastUpdated tracks order status changes; authoredOn stays fixed at
      // creation and doesn't reflect the order's current state.
      orderDate: sr.meta?.lastUpdated ?? '',
      note: (sr.note ?? []).map((n) => n.text).filter(Boolean).join('; '),
    });
  }

  return Array.from(groups, ([orderType, items]) => ({ orderType, items }));
}

// Vitals aren't captured under one obs-group concept in this config: Temperature/Pulse/
// Respiratory rate/SpO2 are flat top-level Observations, only Blood Pressure groups
// Systolic/Diastolic/Body position via hasMember (see standard-config/masterdata/
// configuration/bahmniforms/vitals.json). The "Vitals" form can also be filled twice in
// one encounter (e.g. via the "Vitals" and "Second Vitals" forms), so we take the latest
// reading per concept by effectiveDateTime rather than assuming one reading per encounter.
const VITAL_DISPLAY_ORDER = [
  'Temperature',
  'Pulse',
  'Respiratory rate',
  'Systolic blood pressure',
  'Diastolic blood pressure',
  'Body position',
  'Arterial blood oxygen saturation (pulse oximeter)',
];

function buildVitals(bundle) {
  const resources = (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
  const byId = new Map(resources.map((o) => [o.id, o]));
  const groups = resources.filter((o) => Array.isArray(o.hasMember) && o.hasMember.length > 0);
  const groupMemberIds = new Set(groups.flatMap((g) => g.hasMember.map((ref) => refId(ref.reference))));

  const flatObs = resources.filter((o) => !groups.includes(o) && !groupMemberIds.has(o.id));
  const memberObs = groups.flatMap((g) => g.hasMember.map((ref) => byId.get(refId(ref.reference))).filter(Boolean));

  const latestByConcept = new Map();
  for (const obs of [...flatObs, ...memberObs]) {
    const concept = obs.code?.text ?? obs.code?.coding?.[0]?.display ?? '';
    if (!concept) continue;

    const time = obs.effectiveDateTime ?? obs.issued ?? '';
    if (!latestByConcept.has(concept) || time > latestByConcept.get(concept).time) {
      latestByConcept.set(concept, { time, obs });
    }
  }

  return VITAL_DISPLAY_ORDER.filter((concept) => latestByConcept.has(concept)).map((concept) => {
    const obs = latestByConcept.get(concept).obs;
    return {
      concept,
      value: vitalValue(obs),
      range: vitalRangeLabel(obs),
      abnormal: obs.interpretation?.[0]?.coding?.[0]?.code === 'A',
    };
  });
}

function vitalValue(obs) {
  if (obs.valueQuantity?.value != null) return `${obs.valueQuantity.value}${obs.valueQuantity.unit ? ` ${obs.valueQuantity.unit}` : ''}`;
  if (obs.valueCodeableConcept) return obs.valueCodeableConcept.text ?? obs.valueCodeableConcept.coding?.[0]?.display ?? '';
  return obs.valueString ?? '';
}

// e.g. "(60 - 100) beats/min" when both bounds are set, "(>95) %" when only a lower
// bound is configured (as with SpO2), or "" when no normal-typed range exists (e.g.
// Body position, which is categorical and has no reference range at all).
function vitalRangeLabel(obs) {
  const ranges = obs.referenceRange ?? [];
  const range = ranges.find((r) => r.type?.coding?.[0]?.code === 'normal') ?? ranges[0];
  if (!range) return '';

  const { low, high } = range;
  const unit = low?.unit ?? high?.unit ?? '';
  let label = '';
  if (low?.value != null && high?.value != null) label = `(${low.value} - ${high.value})`;
  else if (low?.value != null) label = `(>${low.value})`;
  else if (high?.value != null) label = `(<${high.value})`;
  if (!label) return '';
  return unit ? `${label} ${unit}` : label;
}
