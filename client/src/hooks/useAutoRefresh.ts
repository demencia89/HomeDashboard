import { useEffect, useRef } from 'react';
import type { RefreshRate } from '../types';

export function useAutoRefresh(enabled: boolean, intervalMs: RefreshRate, callback: () => void | Promise<void>): void {
  const callbackRef = useRef(callback);
  const runningRef = useRef(false);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || intervalMs === 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (runningRef.current) {
        return;
      }

      runningRef.current = true;
      void Promise.resolve(callbackRef.current()).finally(() => {
        runningRef.current = false;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
}
