import type { ScreenDef } from './types.ts';
import { Inventory } from '../screens/Inventory.tsx';
import { ReceiveGoods } from '../screens/ReceiveGoods.tsx';
import { Stocktake } from '../screens/Stocktake.tsx';
import { StockMovements } from '../screens/StockMovements.tsx';
import { Requisitions } from '../screens/Requisitions.tsx';
import { PurchaseOrders } from '../screens/PurchaseOrders.tsx';
import { Equipment } from '../screens/Equipment.tsx';

/** Stock and expiry. */
export const screens: ScreenDef[] = [
  { id: 'inventory', moduleId: 'inventory', label: 'Inventory', hint: 'Stock and expiry', render: () => <Inventory /> },
  { id: 'receive-goods', moduleId: 'inventory', label: 'Receive goods', hint: 'Goods receipt into stock', render: () => <ReceiveGoods /> },
  { id: 'stocktake', moduleId: 'inventory', label: 'Stocktake', hint: 'Physical count with variance approval', render: () => <Stocktake /> },
  { id: 'stock-movements', moduleId: 'inventory', label: 'Stock movements', hint: 'Consumption and wastage report', render: () => <StockMovements /> },
  { id: 'requisitions', moduleId: 'inventory', label: 'Requisitions', hint: 'Raise and decide purchase requisitions', render: () => <Requisitions /> },
  { id: 'purchase-orders', moduleId: 'inventory', label: 'Purchase orders', hint: 'Raise a PO from an approved requisition', render: () => <PurchaseOrders /> },
  { id: 'equipment', moduleId: 'inventory', label: 'Equipment', hint: 'Asset register and service due', render: () => <Equipment /> },
];
