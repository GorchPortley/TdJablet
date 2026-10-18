import { App } from './App.js';
import { toast } from './ui/dom.js';

const app = new App(document.getElementById('app'));
window.tdj = app; // handy in the browser console
app.init().catch((e) => {
  console.error(e);
  toast(`Could not start: ${e.message}`, 10000);
});

window.addEventListener('unhandledrejection', (e) => console.error('unhandled', e.reason));

// Offline support. Skipped on localhost so development always gets fresh files.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && !local) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}

// Stop iOS from turning a double tap or pinch into page zoom.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
