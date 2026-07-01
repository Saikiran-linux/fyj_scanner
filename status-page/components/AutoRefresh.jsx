'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Periodically refreshes the current route's server data via router.refresh()
 * — re-fetches server components in place, no full document reload, no URL
 * change, and client state is preserved.
 *
 * Why not <meta http-equiv="refresh">: a meta refresh is scheduled by the
 * browser when the document is first parsed and is NOT cancelled by client-side
 * (SPA) navigation. After you click another tab, the document URL is still the
 * one the page was loaded from ("/"), so when the meta timer fires it reloads
 * that original URL and bounces you back to Overview. This component instead
 * unmounts when you navigate away (App Router unmounts the page), so its
 * interval is cleared and it can never fire on another page.
 */
export default function AutoRefresh({ seconds = 30 }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
