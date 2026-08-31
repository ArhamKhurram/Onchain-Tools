import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Lazy: the updates + announcement modals (slide deck, hero art, changelog data)
// are overlay chrome — nothing at boot depends on them, and statically importing
// them here put ~25 kB of slide content into the index chunk on every load.
// React.lazy moves them into their own chunk fetched after first paint; they
// mount a tick later, which is invisible for overlays.
const AnnouncementModal = React.lazy(() => import('./components/AnnouncementModal'));
const UpdatesModal = React.lazy(() => import('./components/UpdatesModal'));
// Lazy: the popout is a separate ?popout=1 window. A static import here dragged
// the entire chat stack (ChatPane, Message, @tanstack/virtual, ChatInput, room
// config) into the initial index chunk for EVERY normal page load, even though
// only popout windows render it.
const PopoutView = React.lazy(() => import('./components/PopoutView'));
import { IS_POPOUT } from './stores/appStore';
import { initTheme } from './stores/themeStore';
import { initAnalytics } from './lib/analytics';
import './index.css';

initTheme();
initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {IS_POPOUT ? (
      <React.Suspense fallback={null}>
        <PopoutView />
      </React.Suspense>
    ) : (
      <>
        <App />
        <React.Suspense fallback={null}>
          <UpdatesModal />
          <AnnouncementModal />
        </React.Suspense>
      </>
    )}
  </React.StrictMode>,
);
