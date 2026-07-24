import type { ScreenDef } from './types.ts';
import { Dashboard } from '../screens/Dashboard.tsx';
import { IncomeStatement } from '../screens/IncomeStatement.tsx';
import { BalanceSheet } from '../screens/BalanceSheet.tsx';
import { GeneralLedger } from '../screens/GeneralLedger.tsx';
import { PeriodClose } from '../screens/PeriodClose.tsx';
import { BudgetVsActual } from '../screens/BudgetVsActual.tsx';
import { ManualJournal } from '../screens/ManualJournal.tsx';
import { DashboardExport } from '../screens/DashboardExport.tsx';
import { FinanceExpense } from '../screens/FinanceExpense.tsx';
import { FinanceMonthlyClose } from '../screens/FinanceMonthlyClose.tsx';
import { FinanceJournalReview } from '../screens/FinanceJournalReview.tsx';
import { FinanceCostCentres } from '../screens/FinanceCostCentres.tsx';
import { FinanceDimensions } from '../screens/FinanceDimensions.tsx';
import { FinanceMargin } from '../screens/FinanceMargin.tsx';
import { FinanceApRecon } from '../screens/FinanceApRecon.tsx';
import { FinanceAssets } from '../screens/FinanceAssets.tsx';
import { FinanceAccounts } from '../screens/FinanceAccounts.tsx';

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
  { id: 'finance-cost-centres', moduleId: 'management', label: 'Cost centres', hint: 'Finance control', render: () => <FinanceCostCentres /> },
  { id: 'finance-dimensions', moduleId: 'management', label: 'Reporting dimensions', hint: 'Finance control', render: () => <FinanceDimensions /> },
  { id: 'finance-margin', moduleId: 'management', label: 'Margin & break-even', hint: 'Finance report', render: () => <FinanceMargin /> },
  { id: 'finance-ap-recon', moduleId: 'management', label: 'AP reconciliation', hint: 'Finance control', render: () => <FinanceApRecon /> },
  { id: 'finance-assets', moduleId: 'management', label: 'Asset register', hint: 'Finance control', render: () => <FinanceAssets /> },
  { id: 'finance-accounts', moduleId: 'management', label: 'Chart of accounts', hint: 'Finance control', render: () => <FinanceAccounts /> },
  { id: 'finance-expense', moduleId: 'management', label: 'Expense capture', hint: 'Finance control', render: () => <FinanceExpense /> },
  { id: 'finance-monthly-close', moduleId: 'management', label: 'Period close', hint: 'Finance control', render: () => <FinanceMonthlyClose /> },
  { id: 'finance-journal-review', moduleId: 'management', label: 'Journal review', hint: 'Maker-checker posting', render: () => <FinanceJournalReview /> },
];
