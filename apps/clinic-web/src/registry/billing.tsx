import type { ScreenDef } from './types.ts';
import { Cashier } from '../screens/Cashier.tsx';
import { Finance } from '../screens/Finance.tsx';
import { InvoiceBalance } from '../screens/InvoiceBalance.tsx';
import { PaymentAllocation } from '../screens/PaymentAllocation.tsx';
import { PaymentReallocation } from '../screens/PaymentReallocation.tsx';
import { Refunds } from '../screens/Refunds.tsx';

/** Cashier operations and the finance ledger. */
export const screens: ScreenDef[] = [
  { id: 'cashier', moduleId: 'billing', label: 'Cashier', hint: 'Shift close and drawer', render: () => <Cashier /> },
  { id: 'finance', moduleId: 'billing', label: 'Finance', hint: 'Debtors and ledger', render: () => <Finance /> },
  { id: 'bill-invoice', moduleId: 'billing', label: 'Invoice balance', hint: 'Outstanding lookup', render: () => <InvoiceBalance /> },
  { id: 'bill-allocate', moduleId: 'billing', label: 'Allocation', hint: 'Apply a payment to invoices', render: () => <PaymentAllocation /> },
  { id: 'bill-reallocate', moduleId: 'billing', label: 'Reallocation', hint: 'Correct a misapplied payment', render: () => <PaymentReallocation /> },
  { id: 'bill-refund', moduleId: 'billing', label: 'Refunds', hint: 'Authorised payment refund', render: () => <Refunds /> },
];
