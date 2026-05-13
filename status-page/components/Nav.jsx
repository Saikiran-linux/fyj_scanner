'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Overview' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/scans', label: 'Scans' },
  { href: '/companies', label: 'Companies' },
];

export default function Nav() {
  const path = usePathname() || '/';
  return (
    <nav className="border-b border-zinc-800">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6 text-sm">
        <span className="font-semibold text-zinc-100">fyj_scanner</span>
        <ul className="flex gap-1">
          {TABS.map((t) => {
            const active = t.href === '/' ? path === '/' : path.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={`px-3 py-1.5 rounded transition-colors ${
                    active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
