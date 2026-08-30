import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { LiveAirspaceRuntime } from '../../live/runtime';

export function useLiveAirspace(runtime: LiveAirspaceRuntime, enabled: boolean) {
  const subscribe = useCallback(
    (notify: () => void) => runtime.subscribe(() => notify()),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.state, [runtime]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (enabled) runtime.start();
    else runtime.stop();
    const hide = () => runtime.stop();
    const show = (event: PageTransitionEvent) => {
      if (enabled && event.persisted) runtime.start();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      runtime.stop();
    };
  }, [runtime, enabled]);
  return state;
}
