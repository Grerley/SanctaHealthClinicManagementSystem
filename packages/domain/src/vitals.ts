/**
 * Vital-sign capture and plausible-range validation (TRI-002/003, UAT-03).
 *
 * Two ranges per observation: a HARD implausible range (almost certainly a data
 * error — e.g. a spreadsheet date serial in an age field) and a SOFT reference
 * range (clinically notable). Out-of-range never silently rejects; it returns a
 * flag so the UI asks the user to CONFIRM or correct without losing data.
 *
 * These defaults are configuration placeholders; real ranges are clinically
 * governed and effective-dated (pack §19). Decision support assists, never decides.
 */

export type VitalKind =
  | 'temperature_c'
  | 'systolic_bp'
  | 'diastolic_bp'
  | 'pulse_bpm'
  | 'respiratory_rate'
  | 'spo2_pct'
  | 'weight_kg'
  | 'height_cm'
  | 'glucose_mmol';

type Range = { min: number; max: number };

/** [hard-implausible, soft-reference] bounds. */
const RANGES: Record<VitalKind, { hard: Range; soft: Range; unit: string }> = {
  temperature_c: { hard: { min: 25, max: 45 }, soft: { min: 36, max: 37.5 }, unit: '°C' },
  systolic_bp: { hard: { min: 40, max: 300 }, soft: { min: 90, max: 140 }, unit: 'mmHg' },
  diastolic_bp: { hard: { min: 20, max: 200 }, soft: { min: 60, max: 90 }, unit: 'mmHg' },
  pulse_bpm: { hard: { min: 20, max: 300 }, soft: { min: 60, max: 100 }, unit: 'bpm' },
  respiratory_rate: { hard: { min: 4, max: 80 }, soft: { min: 12, max: 20 }, unit: '/min' },
  spo2_pct: { hard: { min: 40, max: 100 }, soft: { min: 94, max: 100 }, unit: '%' },
  weight_kg: { hard: { min: 0.3, max: 400 }, soft: { min: 2, max: 200 }, unit: 'kg' },
  height_cm: { hard: { min: 20, max: 260 }, soft: { min: 40, max: 210 }, unit: 'cm' },
  glucose_mmol: { hard: { min: 0.5, max: 60 }, soft: { min: 4, max: 7.8 }, unit: 'mmol/L' },
};

export type VitalFlag = 'ok' | 'out_of_reference' | 'implausible';

export type VitalValidation = {
  kind: VitalKind;
  value: number;
  unit: string;
  flag: VitalFlag;
  /** True when the value is a hard-implausible outlier and needs confirmation. */
  requiresConfirmation: boolean;
  message?: string;
};

export class VitalError extends Error {}

export function validateVital(kind: VitalKind, value: number): VitalValidation {
  const spec = RANGES[kind];
  if (spec === undefined) throw new VitalError(`unknown vital ${kind}`);
  if (!Number.isFinite(value)) throw new VitalError(`vital ${kind} must be a finite number`);

  if (value < spec.hard.min || value > spec.hard.max) {
    return {
      kind,
      value,
      unit: spec.unit,
      flag: 'implausible',
      requiresConfirmation: true,
      message: `${value}${spec.unit} is outside the plausible range ${spec.hard.min}–${spec.hard.max}${spec.unit}; please confirm or correct.`,
    };
  }
  if (value < spec.soft.min || value > spec.soft.max) {
    return { kind, value, unit: spec.unit, flag: 'out_of_reference', requiresConfirmation: false, message: `${value}${spec.unit} is outside the reference range.` };
  }
  return { kind, value, unit: spec.unit, flag: 'ok', requiresConfirmation: false };
}

export type VitalInput = { kind: VitalKind; value: number };

/**
 * Validate a set of vitals. When any value is implausible, the whole set is
 * accepted only with `confirmed: true` (the clinician confirmed the reading).
 * Throws if an implausible value is submitted without confirmation — the caller
 * must re-present it for confirmation rather than dropping it (TRI-003).
 */
export function validateVitals(inputs: readonly VitalInput[], opts: { confirmed?: boolean } = {}): VitalValidation[] {
  const results = inputs.map((i) => validateVital(i.kind, i.value));
  const needsConfirm = results.filter((r) => r.requiresConfirmation);
  if (needsConfirm.length > 0 && !opts.confirmed) {
    throw new VitalError(`${needsConfirm.length} implausible value(s) require confirmation before saving`);
  }
  return results;
}

/** BMI from weight (kg) and height (cm), rounded to one decimal. */
export function bmi(weightKg: number, heightCm: number): number {
  if (heightCm <= 0) throw new VitalError('height must be positive');
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}
