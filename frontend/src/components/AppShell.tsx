// AppShell.tsx — sidebar + top bar shell wrapping every authenticated page.
// Sidebar is fixed on desktop, an off-canvas drawer (behind a hamburger) on
// mobile — matches the compact-sidebar-but-still-works-on-phone brief.

import { useState, type ReactNode } from 'react';
import {
  LayoutGrid,
  ShoppingCart,
  Users,
  Shirt,
  Package,
  Truck,
  BarChart3,
  Settings as SettingsIcon,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type NavKey =
  | 'dashboard'
  | 'orders'
  | 'customers'
  | 'inventory'
  | 'purchases'
  | 'deliveries'
  | 'reports'
  | 'settings';

const NAV_ITEMS: { key: NavKey; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { key: 'orders', label: 'Orders', icon: ShoppingCart },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'inventory', label: 'Inventory', icon: Shirt },
  { key: 'purchases', label: 'Purchases', icon: Package },
  { key: 'deliveries', label: 'Deliveries', icon: Truck },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
];

export function AppShell({
  active,
  onNavigate,
  staffEmail,
  onSignOut,
  isAdmin,
  children,
}: {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  staffEmail: string;
  onSignOut: () => void;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navItems = isAdmin
    ? [...NAV_ITEMS, { key: 'settings' as const, label: 'Settings', icon: SettingsIcon }]
    : NAV_ITEMS;

  return (
    <div className="flex min-h-screen bg-background">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-56 shrink-0 flex-col border-r border-border bg-card p-4 transition-transform duration-200 md:static md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="mb-6 flex items-center justify-between px-1">
          <span className="text-base font-semibold">Noura OMS</span>
          <button
            className="text-muted-foreground md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          {navItems.map(({ key, label, icon: Icon }) => {
            const isActive = active === key;
            return (
              <button
                key={key}
                onClick={() => {
                  onNavigate(key);
                  setMobileOpen(false);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 md:px-6">
          <button
            className="text-muted-foreground md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <span className="font-semibold text-foreground">Noura OMS</span>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{staffEmail}</span>
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6">{children}</main>

        <footer className="border-t border-border bg-card px-4 py-3 text-center text-xs text-muted-foreground md:px-6">
          Developed By Haris
        </footer>
      </div>
    </div>
  );
}
