import { lazy, Suspense } from 'react';

const GlobalSettings = lazy(() => import('../components/GlobalSettings'));

function SettingsLoader() {
  return (
    <div className="flex items-center justify-center h-full w-full bg-oct-bg">
      <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <Suspense fallback={<SettingsLoader />}>
        <GlobalSettings />
      </Suspense>
    </div>
  );
}
