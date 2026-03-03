/** One entry from GET /api/accounts */
export interface AccountSnapshot {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number; // Unix ms
}
