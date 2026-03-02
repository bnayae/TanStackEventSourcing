export interface ComputeStateResult {
  accountId: string;
  ownerName: string;
  /** Balance from synced events only */
  confirmedBalance: number;
  /** Balance including pending events */
  optimisticBalance: number;
}
