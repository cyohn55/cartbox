/**
 * PostArt — the illustrated backdrop for authored feed posts.
 *
 * Cart and clip cards fill their stage with real gameplay; the authored kinds
 * (news / LFP / tips / devlogs / trivia / achievements) had only bare text on
 * black. This gives each of them a themed, self-contained SVG scene — a retro
 * pixel horizon in the kind's accent colour with a simple emblem — so every
 * card in the feed carries an image, not just the playable ones.
 *
 * The art is pure inline SVG: no network request, crisp at any card size, and
 * identical in the live and static builds. It sits in an `os-card-stage`, behind
 * the same scrim the cart cards use, so the post's title and body stay legible.
 */

import type { FeedItemKind } from "@/lib/feedMix";

/** Accent + a darker companion, drawn from each kind's badge colour. */
interface Theme {
  accent: string;
  deep: string;
}

const THEMES: Record<FeedItemKind, Theme> = {
  cart: { accent: "#f6b74a", deep: "#2a1c3f" },
  clip: { accent: "#ff5d8f", deep: "#331033" },
  achievement: { accent: "#57d18d", deep: "#0d2f24" },
  news: { accent: "#8f86c6", deep: "#221b3c" },
  lfp: { accent: "#ff8fae", deep: "#3a132a" },
  dev_tip: { accent: "#6fdfa8", deep: "#0f2e2a" },
  dev_post: { accent: "#6fdfa8", deep: "#122036" },
  trivia: { accent: "#f6b74a", deep: "#33260f" },
};

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 420;

/** Deterministic starfield so the backdrop reads as a retro night sky. */
const STARS: ReadonlyArray<{ x: number; y: number; r: number }> = [
  { x: 28, y: 44, r: 2 },
  { x: 74, y: 26, r: 1.5 },
  { x: 132, y: 58, r: 2.5 },
  { x: 196, y: 32, r: 1.5 },
  { x: 250, y: 52, r: 2 },
  { x: 292, y: 30, r: 1.5 },
  { x: 52, y: 96, r: 1.5 },
  { x: 168, y: 104, r: 2 },
  { x: 228, y: 88, r: 1.5 },
  { x: 284, y: 112, r: 2 },
];

/** Kind-specific emblem, centred in the upper scene above the horizon. */
function Emblem({ kind, accent }: { kind: FeedItemKind; accent: string }) {
  switch (kind) {
    case "news":
      // Broadcast tower emitting signal arcs.
      return (
        <g stroke={accent} strokeWidth={6} fill="none" strokeLinecap="round">
          <path d="M160 200 L136 250 L184 250 Z" fill={accent} stroke="none" />
          <line x1="160" y1="150" x2="160" y2="210" />
          <path d="M132 168 A40 40 0 0 1 188 168" />
          <path d="M116 150 A62 62 0 0 1 204 150" />
        </g>
      );
    case "lfp":
      // A gamepad silhouette: two players welcome.
      return (
        <g fill={accent}>
          <rect x="112" y="176" width="96" height="52" rx="24" />
          <rect x="126" y="192" width="8" height="20" fill="#0d0a16" />
          <rect x="118" y="200" width="24" height="8" fill="#0d0a16" />
          <circle cx="182" cy="196" r="6" fill="#0d0a16" />
          <circle cx="196" cy="210" r="6" fill="#0d0a16" />
        </g>
      );
    case "dev_tip":
      // A lightbulb: the "tip" idea.
      return (
        <g fill={accent}>
          <circle cx="160" cy="188" r="30" />
          <rect x="148" y="214" width="24" height="14" rx="3" />
          <rect x="152" y="230" width="16" height="6" rx="3" fill="#0d0a16" />
          <rect x="156" y="180" width="8" height="24" fill="#0d0a16" opacity="0.5" />
        </g>
      );
    case "dev_post":
      // Angle brackets: a developer's log.
      return (
        <g stroke={accent} strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="146,168 118,200 146,232" />
          <polyline points="174,168 202,200 174,232" />
        </g>
      );
    case "achievement":
      // A trophy on its plinth.
      return (
        <g fill={accent}>
          <path d="M138 168 h44 v14 a22 22 0 0 1 -44 0 Z" />
          <path d="M132 172 a10 10 0 0 1 6 18" fill="none" stroke={accent} strokeWidth={5} />
          <path d="M188 172 a10 10 0 0 0 -6 18" fill="none" stroke={accent} strokeWidth={5} />
          <rect x="154" y="200" width="12" height="14" />
          <rect x="142" y="214" width="36" height="8" rx="2" />
        </g>
      );
    case "trivia":
    default:
      // A quiz question mark inside a rounded card.
      return (
        <g>
          <rect x="128" y="158" width="64" height="64" rx="12" fill={accent} />
          <text
            x="160"
            y="204"
            textAnchor="middle"
            fontSize="52"
            fontWeight="700"
            fontFamily="ui-monospace, monospace"
            fill="#0d0a16"
          >
            ?
          </text>
        </g>
      );
  }
}

/**
 * Renders the backdrop scene for a post `kind`. Fills its container and clips to
 * cover (portrait card), so it behaves like the cart-card thumbnail image.
 */
export function PostArt({ kind }: { kind: FeedItemKind }) {
  const theme = THEMES[kind] ?? THEMES.trivia;
  const gradientId = `post-art-sky-${kind}`;
  const horizon = 250;

  return (
    <svg
      className="os-post-art"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.deep} />
          <stop offset="100%" stopColor="#07050d" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${gradientId})`} />

      {STARS.map((star, index) => (
        <circle key={index} cx={star.x} cy={star.y} r={star.r} fill={theme.accent} opacity={0.5} />
      ))}

      {/* Sun/moon disc behind the emblem, tinted by the kind accent. */}
      <circle cx="160" cy="150" r="70" fill={theme.accent} opacity={0.12} />

      <Emblem kind={kind} accent={theme.accent} />

      {/* Pixel horizon: a receding ground grid grounds the retro scene. */}
      <rect x="0" y={horizon} width={VIEW_WIDTH} height={VIEW_HEIGHT - horizon} fill="#0a0713" />
      <line x1="0" y1={horizon} x2={VIEW_WIDTH} y2={horizon} stroke={theme.accent} strokeWidth={2} opacity={0.7} />
      {[0, 1, 2, 3, 4].map((row) => {
        const y = horizon + 14 + row * (row + 1) * 4;
        return <line key={row} x1="0" y1={y} x2={VIEW_WIDTH} y2={y} stroke={theme.accent} strokeWidth={1} opacity={0.14} />;
      })}
      {[-2, -1, 0, 1, 2].map((column) => (
        <line
          key={column}
          x1={160 + column * 40}
          y1={horizon}
          x2={160 + column * 150}
          y2={VIEW_HEIGHT}
          stroke={theme.accent}
          strokeWidth={1}
          opacity={0.14}
        />
      ))}
    </svg>
  );
}
