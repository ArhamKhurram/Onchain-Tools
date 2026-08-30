import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AnnouncementModal from './components/AnnouncementModal';
import UpdatesModal from './components/UpdatesModal';
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
        <UpdatesModal />
        <AnnouncementModal />
      </>
    )}
  </React.StrictMode>,
);
