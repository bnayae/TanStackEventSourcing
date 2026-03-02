import { useContext } from 'react';
import type { NetworkStatusContextValue } from './NetworkStatusContextValue.js';
import { NetworkStatusContext } from './networkStatusContextInstance.js';

export function useNetworkStatusContext(): NetworkStatusContextValue {
  const ctx = useContext(NetworkStatusContext);
  if (ctx === null) {
    throw new Error('useNetworkStatusContext must be used within NetworkStatusProvider');
  }
  return ctx;
}
