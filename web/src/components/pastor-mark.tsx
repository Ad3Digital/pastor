// The Pastor mark: a shepherd's crook (cajado), whose curl also reads as the P of Pastor, with two
// small beads (the flock) that orbit the crook's head while something is loading.
//
// It keeps the contract the rest of the app was written against (see src/test/pastor-mark.ts):
//   - one inline <svg> carrying a <style> that is identical for every instance, because a stylesheet
//     inside an inline SVG is document-scoped;
//   - every per-instance difference lives on the element as CSS custom properties
//     (--cm-turn, --cm-a1, --cm-a2, --cm-paper) plus the `cm-live` class while loading;
//   - every animation is named `cm-*` (pastor-home.tsx ramps them through getAnimations) and is
//     stopped under prefers-reduced-motion, while the accent colours still bloom.
import { useId, useMemo } from "react";
import type { CSSProperties } from "react";

// One full turn of the flock, in seconds. pastor-home.tsx keeps a copy of TURN.live in ms.
const TURN = { live: 1.8, rest: 48 } as const;

const STYLE =
  ".cm-b{transform-origin:37px 24px;transform-box:view-box}" +
  ".cm-sway{transform-origin:25px 57px;transform-box:view-box}" +
  ".cm-live .cm-b{animation:cm-orbit var(--cm-turn) linear infinite}" +
  ".cm-live .cm-sway{animation:cm-sway calc(var(--cm-turn) * 2) ease-in-out infinite}" +
  "@keyframes cm-orbit{to{transform:rotate(360deg)}}" +
  "@keyframes cm-sway{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-4deg)}}" +
  "@media (prefers-reduced-motion: reduce){.cm-b,.cm-sway{animation:none!important}}";

const CROOK = "M25 57 V23 a12 12 0 0 1 24 0 v2.5 a5.5 5.5 0 0 1 -9.5 3.8";

const vars = (loading: boolean, paper: string): CSSProperties => {
  const set = {
    "--cm-turn": (loading ? TURN.live : TURN.rest) + "s",
    "--cm-a1": loading ? "oklch(0.8 0.17 70)" : "oklch(0.74 0.13 70)",
    "--cm-a2": loading ? "oklch(0.75 0.17 295)" : "oklch(0.698 0.127 295)",
    "--cm-paper": paper,
  };
  // SAFETY: every key is a CSS custom property and every value is a string; React passes them to
  // the DOM as written. The cast exists only because CSSProperties has no `--*` index signature.
  return set as CSSProperties;
};

export interface PastorMarkProps {
  /** Rendered width and height, in pixels. */
  size?: number;
  /** While something is fetching: the flock circles the crook and the accents come to full chroma. */
  loading?: boolean;
  /** Whatever the mark is sitting on; the beads are ringed in it so they read as in front. */
  paper?: string;
  /** An accessible name. Without one the mark is decorative and hidden from assistive tech. */
  title?: string;
  /** Forwarded to the element. */
  className?: string;
  /** `header` below about 80px: cropped tighter, with a heavier line. */
  weight?: "full" | "header";
}

export function PastorMark({
  size = 32,
  loading = false,
  paper = "var(--background)",
  title,
  weight = "full",
  className,
}: PastorMarkProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const style = useMemo(() => vars(loading, paper), [loading, paper]);
  const header = weight === "header";
  const classes = [className, loading ? "cm-live" : null].filter(Boolean).join(" ") || undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={header ? "10 6 48 54" : "0 0 64 64"}
      width={size}
      height={size}
      className={classes}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-mark={uid}
    >
      <style>{STYLE}</style>
      <g className="cm-sway">
        <path
          d={CROOK}
          fill="none"
          stroke="currentColor"
          strokeWidth={header ? 7.5 : 6.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="39.3" cy="29.6" r="3.9" fill="var(--cm-a1)" />
      </g>
      <g className="cm-b cm-b1">
        <circle cx="37" cy="5" r="3" fill="var(--cm-a1)" stroke="var(--cm-paper)" strokeWidth="1.5" />
        <circle cx="37" cy="5" r="3" fill="var(--cm-a1)" opacity="0" />
      </g>
      <g className="cm-b cm-b2">
        <circle cx="37" cy="43" r="2.4" fill="var(--cm-a2)" stroke="var(--cm-paper)" strokeWidth="1.5" />
        <circle cx="37" cy="43" r="2.4" fill="var(--cm-a2)" opacity="0" />
      </g>
    </svg>
  );
}
