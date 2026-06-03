import { flushSync } from 'react-dom';

export function runLayoutTransition(update: () => void): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    update();
    return;
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startViewTransition = 'startViewTransition' in document && typeof document.startViewTransition === 'function'
    ? document.startViewTransition.bind(document)
    : undefined;

  if (!startViewTransition || prefersReducedMotion) {
    update();
    return;
  }

  try {
    startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    update();
  }
}
