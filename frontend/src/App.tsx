// useSession.ts + App.tsx — gates the whole app behind login. While a
// session check is in flight we show nothing rather than flashing the
// login screen then immediately swapping to the dashboard.

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { Login } from './Login';
import { UpdatePassword } from './UpdatePassword';
import { Dashboard } from './Dashboard';
import { Orders } from './Orders';
import { Inventory } from './Inventory';
import { Customers } from './Customers';
import { Purchases } from './Purchases';
import { Deliveries } from './Deliveries';
import { Reports } from './Reports';
import { Settings } from './Settings';
import { AppShell, type NavKey } from '@/components/AppShell';
import { ComingSoon } from '@/components/ComingSoon';
import { Toaster } from '@/components/ui/sonner';

// Nobody else in the app looks up staff_users.role today (see App.tsx
// header note on staffId) — this is the one place it matters, since it
// gates both the Settings nav item and the route itself.
function useIsAdmin(staffId: string) {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('staff_users')
      .select('role')
      .eq('id', staffId)
      .single()
      .then(({ data }) => {
        if (!cancelled) setIsAdmin(data?.role === 'admin');
      });
    return () => {
      cancelled = true;
    };
  }, [staffId]);

  return isAdmin;
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Supabase signs the user into a temporary session when they land on a
  // recovery link and fires this event instead of SIGNED_IN — we have to
  // catch it here because by the time getSession() resolves, the session
  // already looks like a normal logged-in one.
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true);
      }
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  return {
    session,
    loading,
    isPasswordRecovery,
    clearPasswordRecovery: () => setIsPasswordRecovery(false),
  };
}

export function App() {
  const { session, loading, isPasswordRecovery, clearPasswordRecovery } = useSession();

  return (
    <>
      {(() => {
        if (loading) return null; // or a simple spinner

        // Takes priority over the normal session check — the recovery
        // session is only good for setting a new password, not for using
        // the app.
        if (isPasswordRecovery) return <UpdatePassword onComplete={clearPasswordRecovery} />;

        if (!session) return <Login />;

        // Logged in — staff_users.id === session.user.id (see
        // auth_setup.sql), so any query needing "who is this staff member"
        // just uses session.user.id directly, no separate lookup required.
        return <MainApp staffId={session.user.id} staffEmail={session.user.email ?? ''} />;
      })()}
      <Toaster position="top-right" richColors />
    </>
  );
}

function MainApp({ staffId, staffEmail }: { staffId: string; staffEmail: string }) {
  const [active, setActive] = useState<NavKey>('dashboard');
  const isAdmin = useIsAdmin(staffId);

  // Cross-screen links from Reports.tsx ("Sales by customer" / "Sales by
  // item") — Reports doesn't own the nav, so it hands the target back up
  // here via a callback, which stashes it and switches `active` directly.
  // Customers/Orders only ever read their initial* prop once on mount (see
  // their own comments), so a fresh mount from a Reports link is all this
  // needs — no syncing required. Any ordinary sidebar click goes through
  // onNavigate instead, which clears both so a stale target never leaks
  // into a manually-opened Customers/Orders screen.
  const [preselectCustomerId, setPreselectCustomerId] = useState<string | null>(null);
  const [preselectProductFilter, setPreselectProductFilter] = useState<{ id: string; name: string } | null>(null);

  return (
    <AppShell
      active={active}
      onNavigate={(key) => {
        setPreselectCustomerId(null);
        setPreselectProductFilter(null);
        setActive(key);
      }}
      staffEmail={staffEmail}
      onSignOut={() => supabase.auth.signOut()}
      isAdmin={isAdmin}
    >
      {(() => {
        switch (active) {
          case 'dashboard':
            return <Dashboard staffId={staffId} />;
          case 'orders':
            return <Orders staffId={staffId} initialProductFilter={preselectProductFilter} />;
          case 'inventory':
            return <Inventory />;
          case 'customers':
            return <Customers initialSelectedId={preselectCustomerId} />;
          case 'purchases':
            return <Purchases staffId={staffId} />;
          case 'deliveries':
            return <Deliveries />;
          case 'reports':
            return (
              <Reports
                onNavigateToCustomer={(id) => {
                  setPreselectCustomerId(id);
                  setActive('customers');
                }}
                onNavigateToProductOrders={(id, name) => {
                  setPreselectProductFilter({ id, name });
                  setActive('orders');
                }}
              />
            );
          case 'settings':
            // Gated here too, not just by hiding the nav item — the DB's
            // RLS/view already refuses non-admins any real data either way.
            return isAdmin ? <Settings /> : <ComingSoon title="Settings" />;
        }
      })()}
    </AppShell>
  );
}
