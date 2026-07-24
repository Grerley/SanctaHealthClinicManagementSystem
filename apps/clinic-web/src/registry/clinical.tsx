import type { ScreenDef } from './types.ts';
import { Encounter } from '../screens/Encounter.tsx';
import { Prescribe } from '../screens/Prescribe.tsx';
import { Vitals } from '../screens/Vitals.tsx';
import { Orders } from '../screens/Orders.tsx';
import { Results } from '../screens/Results.tsx';
import { Mar } from '../screens/Mar.tsx';
import { CarePlans } from '../screens/CarePlans.tsx';
import { Referrals } from '../screens/Referrals.tsx';
import { Handover } from '../screens/Handover.tsx';
import { CareFollowups } from '../screens/CareFollowups.tsx';
import { ProblemList } from '../screens/ProblemList.tsx';
import { Allergies } from '../screens/Allergies.tsx';
import { ClinicalForms } from '../screens/ClinicalForms.tsx';
import { DiagnosisLookup } from '../screens/DiagnosisLookup.tsx';
import { OrderSets } from '../screens/OrderSets.tsx';
import { SpecimenLabels } from '../screens/SpecimenLabels.tsx';
import { ExternalResults } from '../screens/ExternalResults.tsx';
import { UnmatchedResults } from '../screens/UnmatchedResults.tsx';
import { ResultCorrection } from '../screens/ResultCorrection.tsx';
import { RxTemplates } from '../screens/RxTemplates.tsx';
import { DispenseWorklist } from '../screens/DispenseWorklist.tsx';
import { Formulary } from '../screens/Formulary.tsx';
import { AdminHistory } from '../screens/AdminHistory.tsx';
import { EncounterVoid } from '../screens/EncounterVoid.tsx';
import { ReferralStatus } from '../screens/ReferralStatus.tsx';
import { RecordDiagnosis } from '../screens/RecordDiagnosis.tsx';

/** Clinical work — encounter, prescribing, observations, orders/results, MAR,
 * care plans, referrals and shift handover. */
export const screens: ScreenDef[] = [
  { id: 'encounter', moduleId: 'clinical', label: 'Encounter', hint: 'Document and sign', render: (ctx) => <Encounter patient={ctx.patient} /> },
  { id: 'prescribe', moduleId: 'clinical', label: 'Prescribe', hint: 'Medication and allergy check', render: (ctx) => <Prescribe patient={ctx.patient} /> },
  { id: 'vitals', moduleId: 'clinical', label: 'Vitals', hint: 'Triage observations', render: (ctx) => <Vitals patient={ctx.patient} /> },
  { id: 'orders', moduleId: 'clinical', label: 'Orders', hint: 'Labs, imaging, referrals', render: (ctx) => <Orders patient={ctx.patient} /> },
  { id: 'results', moduleId: 'clinical', label: 'Results', hint: 'Enter and classify results', render: () => <Results /> },
  { id: 'mar', moduleId: 'clinical', label: 'Med round', hint: 'Administer medications', render: () => <Mar /> },
  { id: 'careplans', moduleId: 'clinical', label: 'Care plans', hint: 'Goals and follow-ups', render: (ctx) => <CarePlans patient={ctx.patient} /> },
  { id: 'referrals', moduleId: 'clinical', label: 'Referrals', hint: 'Refer to other facilities', render: (ctx) => <Referrals patient={ctx.patient} /> },
  { id: 'handover', moduleId: 'clinical', label: 'Handover', hint: 'SBAR shift handover', render: () => <Handover /> },
  { id: 'care-followups', moduleId: 'clinical', label: 'Follow-ups', hint: 'Overdue care follow-up queue', render: () => <CareFollowups /> },
  { id: 'problem-list', moduleId: 'clinical', label: 'Problem list', hint: 'Problems, history & status', render: (ctx) => <ProblemList patient={ctx.patient} /> },
  { id: 'allergies', moduleId: 'clinical', label: 'Allergies', hint: 'Record substance allergies', render: (ctx) => <Allergies patient={ctx.patient} /> },
  { id: 'clinical-forms', moduleId: 'clinical', label: 'Clinical forms', hint: 'Versioned form catalogue', render: () => <ClinicalForms /> },
  { id: 'diagnosis-codes', moduleId: 'clinical', label: 'Diagnosis codes', hint: 'Coded diagnosis lookup', render: () => <DiagnosisLookup /> },
  { id: 'order-sets', moduleId: 'clinical', label: 'Order sets', hint: 'Reusable order bundles', render: (ctx) => <OrderSets patient={ctx.patient} /> },
  { id: 'specimen-labels', moduleId: 'clinical', label: 'Specimen labels', hint: 'Identity-safe specimen labels', render: () => <SpecimenLabels /> },
  { id: 'external-results', moduleId: 'clinical', label: 'External results', hint: 'Record outside results', render: (ctx) => <ExternalResults patient={ctx.patient} /> },
  { id: 'unmatched-results', moduleId: 'clinical', label: 'Unmatched results', hint: 'Reconcile unmatched results', render: () => <UnmatchedResults /> },
  { id: 'result-correction', moduleId: 'clinical', label: 'Corrections', hint: 'Correct results, cancel orders', render: () => <ResultCorrection /> },
  { id: 'rx-templates', moduleId: 'clinical', label: 'Rx templates', hint: 'Reusable prescribing protocols', render: () => <RxTemplates /> },
  { id: 'dispense-worklist', moduleId: 'clinical', label: 'Dispensing', hint: 'Pharmacy dispensing worklist', render: () => <DispenseWorklist /> },
  { id: 'formulary', moduleId: 'clinical', label: 'Formulary', hint: 'Medication catalogue', render: () => <Formulary /> },
  { id: 'medication-admin-history', moduleId: 'clinical', label: 'Admin history', hint: 'Administration trail', render: () => <AdminHistory /> },
  { id: 'encounter-void', moduleId: 'clinical', label: 'Void encounter', hint: 'Mark entered-in-error', render: () => <EncounterVoid /> },
  { id: 'referral-status', moduleId: 'clinical', label: 'Referral status', hint: 'Track referrals to close', render: () => <ReferralStatus /> },
  { id: 'record-diagnosis', moduleId: 'clinical', label: 'Record diagnosis', hint: 'Code a diagnosis to an encounter', render: (ctx) => <RecordDiagnosis patient={ctx.patient} /> },
];
