import { useState, useEffect } from "react";
import { initials } from "@/lib/formatters";
import { cn, optimizeImageUrl } from "@/lib/utils";

const gradients = [
  "from-violet-500 to-fuchsia-500",
  "from-orange-500 to-rose-500",
  "from-sky-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-indigo-500 to-violet-500",
];

function gradientFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return gradients[hash % gradients.length]!;
}

export function Avatar({
  name,
  src,
  className,
  ring = false,
}: {
  name: string;
  src?: string | null;
  className?: string;
  ring?: boolean;
}) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [src]);

  const base = cn(
    "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white select-none aspect-square",
    ring && "ring-2 ring-card shadow-sm",
    className ?? "h-10 w-10 text-xs",
  );

  if (src && !imgError) {
    return (
      <span className={base}>
        <img
          src={optimizeImageUrl(src, 160)}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="h-full w-full object-cover rounded-full"
        />
      </span>
    );
  }

  return (
    <span className={cn(base, "bg-gradient-to-br", gradientFor(name))} aria-hidden>
      {initials(name)}
    </span>
  );
}
