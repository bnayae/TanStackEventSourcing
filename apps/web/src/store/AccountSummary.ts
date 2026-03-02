export interface AccountSummary {
  accountId: string;
  ownerName: string;
  balance: number;
  pendingBalance: number;
  pendingEventCount: number;
  totalEventCount: number;
}
