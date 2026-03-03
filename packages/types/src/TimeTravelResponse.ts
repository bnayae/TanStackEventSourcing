/** Response from GET /api/accounts/:id/state?at=<unix_ms> */
export interface TimeTravelResponse {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number; // Unix ms
  snapshotId: number | null;
  eventsReplayed: number;
}
