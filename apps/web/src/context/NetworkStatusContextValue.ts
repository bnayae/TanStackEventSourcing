import type { NetworkStatus } from './NetworkStatus.js';

export interface NetworkStatusContextValue {
  status: NetworkStatus;
  isManuallyOffline: boolean;
  toggleManualOffline: () => void;
}
