"use client";

import { useEffect, useRef } from "react";

type TurnstileApi = { render: (el: HTMLElement, options: { sitekey: string }) => string; remove: (id: string) => void };
const turnstile = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;

/**
 * The Cloudflare Turnstile widget. It renders itself when its script has loaded and adds the one-time token to the form
 * (field cf-turnstile-response). Mount it with a new `key` to get a fresh widget and a fresh token (a token works once).
 */
export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widget: string | undefined;
    const mount = () => {
      const api = turnstile();
      if (!api || !box.current) return false;
      widget = api.render(box.current, { sitekey: siteKey });
      return true;
    };
    // The script loads after the page: try now, then every 200 ms until it is there.
    const timer = mount() ? undefined : setInterval(() => mount() && clearInterval(timer), 200);
    return () => {
      clearInterval(timer);
      if (widget) turnstile()?.remove(widget);
    };
  }, [siteKey]);
  return <div ref={box} />;
}
