import type { JSX } from 'react';
import type { Patient } from '../api.ts';

/** Shared context every screen receives — the patient in context and a setter, so a
 * screen can read the active patient or make itself the one that selects a patient. */
export type ScreenCtx = { patient: Patient | null; setPatient: (p: Patient | null) => void };

/**
 * A registered screen. Adding a screen is a single self-contained change: create the
 * component, then append one ScreenDef to the owning module's registry file — no edit
 * to App.tsx or a central api file, so modules can be built in parallel without
 * conflicts. `id` becomes the stable `tab-<id>` test id and the nav destination.
 */
export type ScreenDef = {
  id: string;
  moduleId: string;
  label: string;
  hint: string;
  render: (ctx: ScreenCtx) => JSX.Element;
};

/** A navigation module — a role-ordered group of screens (spec §4.1). */
export type ModuleDef = { id: string; label: string };
