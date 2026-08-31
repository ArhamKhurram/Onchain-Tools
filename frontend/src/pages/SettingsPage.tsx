import { lazy, Suspense } from 'react';
import FullPageSpinner from '../components/common/FullPageSpinner';

const GlobalSettings = lazy(() => import('../components/GlobalSettings'));

export default function SettingsPage() {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <Suspense fallback={<FullPageSpinner className="w-full" />}>
        <GlobalSettings />
      </Suspense>
    </div>
  );
}
