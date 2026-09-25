/**
 * Generates ui/src/components/Icon.tsx from Material Symbols.
 *
 * The glyphs were drawn by hand once, and it did not go well: the settings
 * cog was a sun, the lyrics button was a chat bubble, and shuffle's
 * arrowheads floated beside lines that ended somewhere else. Drawing icons
 * is a specialist job and this is not the place to do it.
 *
 * Inlined rather than imported at runtime, so the bundle carries the three
 * dozen shapes actually used instead of a library of eight thousand. That is
 * also why this is a generator and not a dependency: the output is committed
 * and reviewable, and regenerating is a deliberate act.
 *
 *   npm i --no-save @material-symbols/svg-400 && node tools/build-icons.mjs
 *
 * Material Symbols is Apache-2.0. See ui/src/components/ICONS-LICENSE.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "ui/node_modules/@material-symbols/svg-400/rounded";

/** Icons with a single appearance. */
const SIMPLE = [
  ["IconSearch", "search"],
  ["IconPlus", "add"],
  ["IconChevronLeft", "chevron_left"],
  ["IconChevronRight", "chevron_right"],
  ["IconChevronDown", "keyboard_arrow_down"],
  ["IconClose", "close"],
  ["IconPlay", "play_arrow-fill"],
  ["IconPause", "pause-fill"],
  ["IconSkipNext", "skip_next-fill"],
  ["IconSkipPrev", "skip_previous-fill"],
  ["IconShuffle", "shuffle"],
  ["IconRepeat", "repeat"],
  ["IconVolume", "volume_up-fill"],
  ["IconVolumeMute", "volume_off-fill"],
  ["IconQueue", "queue_music"],
  ["IconVideo", "smart_display"],
  ["IconFolder", "folder"],
  ["IconDelete", "delete"],
  ["IconArtist", "person"],
  ["IconAlbum", "album"],
  ["IconRadio", "radio"],
  ["IconDevices", "devices"],
  ["IconMore", "more_horiz"],
  ["IconGrid", "grid_view"],
  ["IconList", "list"],
  ["IconExplicit", "explicit-fill"],
  ["IconEqualizerStatic", "bar_chart-fill"],
  ["IconExpand", "open_in_full"],
  ["IconCollapse", "close_fullscreen"],
  ["IconBrowse", "inventory_2"],
  ["IconSettings", "settings-fill"],
  ["IconShare", "share"],
  ["IconMiniPlayer", "picture_in_picture_alt"],
  ["IconOpenApp", "open_in_new"],
];

/** Icons with an active state, which Spotify shows by filling them in. */
const TOGGLING = [
  ["IconHome", "home", "home-fill"],
  ["IconLibrary", "library_music", "library_music-fill"],
  ["IconHeart", "favorite", "favorite-fill"],
  // The mini player's always-on-top toggle: pinned is filled.
  ["IconPin", "keep", "keep-fill"],
];

function pathOf(glyph) {
  const svg = readFileSync(join(SRC, `${glyph}.svg`), "utf8");
  const ds = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length === 0) throw new Error(`no path in ${glyph}.svg`);
  // A few glyphs are drawn as several subpaths; joined, they fill the same.
  return ds.join(" ");
}

const header = `/**
 * Icon set — generated, do not edit by hand.
 *
 * Material Symbols (rounded, weight 400), Apache-2.0: the set YouTube Music
 * itself draws from. Regenerate with \`node tools/build-icons.mjs\`.
 *
 * The paths are inlined so the bundle carries only the shapes actually used,
 * and every one answers to \`currentColor\`.
 *
 * Material's grid is 960 units tall with its origin on the baseline, hence
 * the viewBox. They are filled shapes rather than strokes, which is also what
 * makes them match Spotify: its transport controls are solid, and its
 * navigation fills in on the destination you are looking at.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Svg({ size = 20, title, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
`;

const parts = [header];
for (const [name, glyph] of SIMPLE) {
  parts.push(
    `export const ${name} = (p: Props) => (\n` +
      `  <Svg {...p}><path d="${pathOf(glyph)}" /></Svg>\n);\n`,
  );
}

parts.push(`
/*
 * The ones with an active state.
 *
 * Spotify fills these in rather than tinting them — the destination you are
 * on, and the track you have saved — so both shapes are carried and the
 * caller says which it wants.
 */
`);
for (const [name, outline, fill] of TOGGLING) {
  parts.push(
    `export const ${name} = ({ filled, ...p }: Props & { filled?: boolean }) => (\n` +
      `  <Svg {...p}>\n` +
      `    <path d={filled ? "${pathOf(fill)}" : "${pathOf(outline)}"} />\n` +
      `  </Svg>\n);\n`,
  );
}

/*
 * Lyrics is drawn here rather than taken from Material.
 *
 * Spotify's is a handheld microphone lying at forty-five degrees: a round
 * head joined to a narrower handle, hollow, with a thin wall throughout.
 * Material's mic is an upright solid studio capsule, which is a different
 * object — it kept reading as the wrong button.
 *
 * Traced against a screenshot of the web player's now-playing bar rather
 * than from memory, twice: the first attempt tapered from head to handle
 * and the second was a uniform capsule, and neither is what Spotify draws.
 * The proportion that matters is length to head diameter, about 2.8 to 1.
 *
 * Built upright and rotated, because a microphone is easy to describe
 * pointing up and very hard to describe at an angle. One path, even-odd, so
 * the two chambers are holes rather than shapes laid on top — the icon has
 * to be transparent inside, since it sits on artwork as often as on black.
 */
parts.push(`export const IconLyrics = (p: Props) => (
  <Svg {...p} viewBox="0 0 24 24">
    <g transform="rotate(45 12 12)">
      <path
        fillRule="evenodd"
        d="M14 8.15V19a2 2 0 0 1-4 0V8.15A3.4 3.4 0 1 1 14 8.15Z M12 3.2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 1 0 0-4.4Z M12 8.8a.8.8 0 0 1 .8.8V19a.8.8 0 0 1-1.6 0V9.6a.8.8 0 0 1 .8-.8Z"
      />
    </g>
  </Svg>
);
`);

parts.push(`
/** Animated bars marking the row that is currently sounding. */
export function IconEqualizer({ size = 16, playing = true }: { size?: number; playing?: boolean }) {
  return (
    <span className="equalizer" data-playing={playing} style={{ width: size, height: size }} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}
`);

writeFileSync("ui/src/components/Icon.tsx", parts.join("\n"));
console.log(`wrote ${SIMPLE.length + TOGGLING.length + 1} icons`);
