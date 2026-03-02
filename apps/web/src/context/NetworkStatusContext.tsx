import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

export type NetworkStatus = 'online' | 'offline';

interface NetworkStatusContextValue {
  status: NetworkStatus;
  isManuallyOffline: boolean;
  toggleManualOffline: () => void;
}

const NetworkStatusContext = createContext<NetworkStatusContextValue | null>(null);

export function NetworkStatusProvider({ children }: { children: ReactNode }) {
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [isManuallyOffline, setIsManuallyOffline] = useState(false);

  useEffect(() => {
    const handleOnline = () => setBrowserOnline(true);
    const handleOffline = () => setBrowserOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const toggleManualOffline = useCallback(() => {
    setIsManuallyOffline(prev => !prev);
  }, []);

  const status: NetworkStatus = !browserOnline || isManuallyOffline ? 'offline' : 'online';

  return (
    <NetworkStatusContext.Provider value={{ status, isManuallyOffline, toggleManualOffline }}>
      {children}
    </NetworkStatusContext.Provider>
  );
}

export function useNetworkStatusContext(): NetworkStatusContextValue {
  const ctx = useContext(NetworkStatusContext);
  if (ctx === null) {
    throw new Error('useNetworkStatusContext must be used within NetworkStatusProvider');
  }
  return ctx;
}
