import { Link } from 'react-router-dom';

import { Wallet } from 'lucide-react';

import { useAuthSession } from '../hooks/useAuthSession';

import WalletTracker from '../components/wallets/WalletTracker';



export default function WalletsPage() {

  const { isAuthenticated, ready, userId } = useAuthSession();



  if (!ready) {

    return (

      <div className="flex items-center justify-center h-full">

        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />

      </div>

    );

  }



  if (!isAuthenticated) {

    return (

      <div className="flex items-center justify-center h-full p-6">

        <div className="max-w-md text-center">

          <div className="w-14 h-14 rounded-2xl bg-oct-accent-dim flex items-center justify-center mx-auto mb-5">

            <Wallet size={28} className="text-oct-accent" />

          </div>

          <h2 className="text-xl font-bold text-oct-text mb-2">Sign in to track wallets</h2>

          <p className="text-sm text-oct-muted mb-6 leading-relaxed">

            Your tracked wallets are private — stored in <code className="text-oct-accent">user_tracked_wallets</code> and

            scoped to your account only.

          </p>

          <Link

            to="/dashboard/login"

            className="inline-flex px-5 py-2.5 bg-oct-accent hover:bg-oct-accent-hover rounded-lg text-sm font-medium text-white transition-colors"

          >

            Sign in

          </Link>

        </div>

      </div>

    );

  }



  if (!userId) {

    return (

      <div className="flex items-center justify-center h-full p-6">

        <p className="text-sm text-oct-muted">Unable to load account. Try signing in again.</p>

      </div>

    );

  }



  return (

    <div className="h-full min-h-0 flex flex-col">

      <WalletTracker userId={userId} />

    </div>

  );

}

