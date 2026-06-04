export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) {
        return;
      }

      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).then((registration) => {
      void registration.update();
    }).catch(() => {
      // PWA registration should never block the dashboard.
    });
  });
}
