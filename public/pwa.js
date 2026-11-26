// Registers the service worker so the app can be installed (Add to Home Screen / Install app).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app works the same without it */ });
  });
}
