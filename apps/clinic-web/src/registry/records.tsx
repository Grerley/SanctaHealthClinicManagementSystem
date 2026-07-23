import type { ScreenDef } from './types.ts';
import { Documents } from '../screens/Documents.tsx';
import { DocumentGenerate } from '../screens/DocumentGenerate.tsx';
import { DocumentLifecycle } from '../screens/DocumentLifecycle.tsx';
import { LegalHold } from '../screens/LegalHold.tsx';
import { Retention } from '../screens/Retention.tsx';
import { Disposal } from '../screens/Disposal.tsx';
import { Disclosures } from '../screens/Disclosures.tsx';

/** Document records. */
export const screens: ScreenDef[] = [
  { id: 'documents', moduleId: 'records', label: 'Documents', hint: 'Upload and find files', render: (ctx) => <Documents patient={ctx.patient} /> },
  { id: 'document-generate', moduleId: 'records', label: 'Generate', hint: 'Generate a document from a template', render: (ctx) => <DocumentGenerate patient={ctx.patient} /> },
  { id: 'document-lifecycle', moduleId: 'records', label: 'Version & error', hint: 'Supersede a version or mark entered-in-error', render: () => <DocumentLifecycle /> },
  { id: 'legal-hold', moduleId: 'records', label: 'Legal hold', hint: 'Freeze a document against disposal', render: () => <LegalHold /> },
  { id: 'retention', moduleId: 'records', label: 'Retention', hint: 'Set the retention class and disposal date', render: () => <Retention /> },
  { id: 'disposal', moduleId: 'records', label: 'Disposal', hint: 'Dispose documents past retention', render: () => <Disposal /> },
  { id: 'disclosures', moduleId: 'records', label: 'Disclosures', hint: 'Access log and sensitive-document opens', render: () => <Disclosures /> },
];
