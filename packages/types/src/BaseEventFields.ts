export interface BaseEventFields {
  id: string;
  accountId: string;
  createdAt: number; // Unix timestamp ms
  sequenceNumber: number;
}
