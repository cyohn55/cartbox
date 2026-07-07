"use client";

/**
 * Buy control for a paid cartridge. Posts to /api/checkout and redirects the
 * buyer to the returned Stripe Checkout URL.
 */

import { useState } from "react";

interface BuyButtonProps {
  cartId: string;
  priceCents: number;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function BuyButton({ cartId, priceCents }: BuyButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartId }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? "Checkout failed");
      }
      window.location.href = body.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed");
      setPending(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={startCheckout} disabled={pending}>
        {pending ? "Starting checkout…" : `Buy for ${formatUsd(priceCents)}`}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
