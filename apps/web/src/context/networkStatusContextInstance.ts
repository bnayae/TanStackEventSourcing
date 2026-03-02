import { createContext } from 'react';
import type { NetworkStatusContextValue } from './NetworkStatusContextValue.js';

export const NetworkStatusContext = createContext<NetworkStatusContextValue | null>(null);
