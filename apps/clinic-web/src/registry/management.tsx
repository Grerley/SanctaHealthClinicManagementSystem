import type { ScreenDef } from './types.ts';
import { Dashboard } from '../screens/Dashboard.tsx';
import { IncomeStatement } from '../screens/IncomeStatement.tsx';
import { BalanceSheet } from '../screens/BalanceSheet.tsx';
import { GeneralLedger } from '../screens/GeneralLedger.tsx';
import { PeriodClose } from '../screens/PeriodClose.tsx';
import { BudgetVsActual } from '../screens/BudgetVsActual.tsx';
import { ManualJournal } from '../screens/ManualJournal.tsx';
import { DashboardExport } from '../screens/DashboardExport.tsx';

/** Management — command centre and finance-reporting workspaces. */
export const screens: ScreenDef[] = [
  { id: 'dashboard', moduleId: 'management', label: 'Command centre', hint: 'Management', render: () => <Dashboard /> },
  { id: 'income-statement', moduleId: 'management', label: 'Income statement', hint: 'Finance report', render: () => <IncomeStatement /> },
  { id: 'balance-sheet', moduleId: 'management', label: 'Balance sheet', hint: 'Finance report', render: () => <BalanceSheet /> },
  { id: 'general-ledger', moduleId: 'management', label: 'General ledger', hint: 'Finance report', render: () => <GeneralLedger /> },
  { id: 'period-close', moduleId: 'management', label: 'Period open/close', hint: 'Finance control', render: () => <PeriodClose /> },
  { id: 'budget-variance', moduleId: 'management', label: 'Budget vs actual', hint: 'Finance report', render: () => <BudgetVsActual /> },
  { id: 'manual-journal', moduleId: 'management', label: 'Manual journal', hint: 'Finance control', render: () => <ManualJournal /> },
  { id: 'mgmt-export', moduleId: 'management', label: 'Management pack', hint: 'Export & commentary', render: () => <DashboardExport /> },
];
