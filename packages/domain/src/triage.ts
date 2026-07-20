/**
 * Triage decision SUPPORT (TRI-004, TRI-005, pack §7.2). Two pure, versioned
 * rules over a set of vital readings:
 *
 *  - danger-sign detection: flags readings that warrant visible escalation
 *    (e.g. hypoxia, shock). These are ESCALATIONS for a human to act on — never a
 *    diagnosis. The system assists; it never autonomously diagnoses (TRI-005).
 *  - an early-warning score: a transparent points total with its components and
 *    the rule version shown, so the number is explainable and auditable (TRI-004).
 *
 * Thresholds here are configuration placeholders; real ranges are clinically
 * governed and effective-dated (pack §19).
 */
import type { VitalKind } from './vitals.ts';

export type VitalReading = { kind: VitalKind; value: number };

export type DangerSeverity = 'urgent' | 'emergency';
export type DangerSign = {
  code: string;
  label: string;
  severity: DangerSeverity;
  basis: string;
  /** Always an escalation for a clinician — never a diagnosis (TRI-005). */
  action: 'escalate';
};

export const DANGER_RULE_VERSION = 'danger-signs-1';

function reading(readings: readonly VitalReading[], kind: VitalKind): number | undefined {
  return readings.find((r) => r.kind === kind)?.value;
}

/** Detect visible danger signs from vitals. Returns escalations, most severe first. */
export function detectDangerSigns(readings: readonly VitalReading[]): DangerSign[] {
  const out: DangerSign[] = [];
  const push = (code: string, label: string, severity: DangerSeverity, basis: string) => out.push({ code, label, severity, basis, action: 'escalate' });

  const spo2 = reading(readings, 'spo2_pct');
  if (spo2 !== undefined) {
    if (spo2 < 90) push('hypoxia_severe', 'Severe hypoxia', 'emergency', `SpO₂ ${spo2}% < 90%`);
    else if (spo2 < 92) push('hypoxia', 'Hypoxia', 'urgent', `SpO₂ ${spo2}% < 92%`);
  }
  const sbp = reading(readings, 'systolic_bp');
  if (sbp !== undefined && sbp < 90) push('hypotension', 'Hypotension / shock', 'emergency', `Systolic ${sbp} < 90 mmHg`);
  const rr = reading(readings, 'respiratory_rate');
  if (rr !== undefined) {
    if (rr >= 30 || rr < 8) push('respiratory_distress', 'Respiratory distress', 'emergency', `Respiratory rate ${rr}/min`);
    else if (rr >= 25) push('tachypnoea', 'Tachypnoea', 'urgent', `Respiratory rate ${rr}/min`);
  }
  const pulse = reading(readings, 'pulse_bpm');
  if (pulse !== undefined && (pulse > 130 || pulse < 40)) push('arrhythmia_risk', 'Extreme heart rate', 'urgent', `Pulse ${pulse} bpm`);
  const temp = reading(readings, 'temperature_c');
  if (temp !== undefined) {
    if (temp >= 39.5) push('high_fever', 'High fever', 'urgent', `Temperature ${temp}°C`);
    else if (temp < 35) push('hypothermia', 'Hypothermia', 'urgent', `Temperature ${temp}°C`);
  }
  const glu = reading(readings, 'glucose_mmol');
  if (glu !== undefined) {
    if (glu < 3) push('hypoglycaemia', 'Hypoglycaemia', 'emergency', `Glucose ${glu} mmol/L < 3`);
    else if (glu > 15) push('hyperglycaemia', 'Hyperglycaemia', 'urgent', `Glucose ${glu} mmol/L > 15`);
  }

  const rank: Record<DangerSeverity, number> = { emergency: 0, urgent: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export type EwsComponent = { param: string; value: number; points: number };
export type EwsBand = 'low' | 'medium' | 'high';
export type EarlyWarning = { score: number; band: EwsBand; components: EwsComponent[]; ruleVersion: string };

export const EWS_RULE_VERSION = 'news-lite-1';

/**
 * A transparent early-warning score. Each contributing parameter is returned with
 * its points and the total carries a band and the rule version (TRI-004).
 */
export function earlyWarningScore(readings: readonly VitalReading[]): EarlyWarning {
  const components: EwsComponent[] = [];
  const add = (param: string, value: number | undefined, fn: (v: number) => number) => {
    if (value === undefined) return;
    const pts = fn(value);
    if (pts > 0) components.push({ param, value, points: pts });
  };

  add('spo2_pct', reading(readings, 'spo2_pct'), (v) => (v >= 96 ? 0 : v >= 94 ? 1 : v >= 92 ? 2 : 3));
  add('respiratory_rate', reading(readings, 'respiratory_rate'), (v) => (v <= 8 ? 3 : v <= 11 ? 1 : v <= 20 ? 0 : v <= 24 ? 2 : 3));
  add('systolic_bp', reading(readings, 'systolic_bp'), (v) => (v <= 90 ? 3 : v <= 100 ? 2 : v <= 110 ? 1 : v >= 220 ? 3 : 0));
  add('pulse_bpm', reading(readings, 'pulse_bpm'), (v) => (v <= 40 ? 3 : v <= 50 ? 1 : v <= 90 ? 0 : v <= 110 ? 1 : v <= 130 ? 2 : 3));
  add('temperature_c', reading(readings, 'temperature_c'), (v) => (v <= 35 ? 3 : v <= 36 ? 1 : v <= 38 ? 0 : v <= 39 ? 1 : 2));

  const score = components.reduce((s, c) => s + c.points, 0);
  const anyThree = components.some((c) => c.points >= 3);
  const band: EwsBand = score >= 7 || anyThree ? 'high' : score >= 5 ? 'medium' : 'low';
  return { score, band, components, ruleVersion: EWS_RULE_VERSION };
}
