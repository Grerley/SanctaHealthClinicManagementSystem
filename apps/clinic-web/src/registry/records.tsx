import type { ScreenDef } from './types.ts';
import { Documents } from '../screens/Documents.tsx';

/** Document records. */
export const screens: ScreenDef[] = [
  { id: 'documents', moduleId: 'records', label: 'Documents', hint: 'Upload and find files', render: (ctx) => <Documents patient={ctx.patient} /> },
];
