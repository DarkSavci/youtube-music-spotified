import text from "../../../CHANGELOG.md?raw";

/**
 * What's new, from CHANGELOG.md.
 *
 * The file is written by git-cliff in the release workflow and bundled into
 * the app at build time, so the history is there offline and always matches
 * the version installed. Only the shape cliff.toml writes is read: a "## "
 * heading per release, "### " per group, "- " per change, and a plain line
 * for a release with nothing to list.
 */

export interface ReleaseGroup {
  title: string;
  items: string[];
}

export interface Release {
  version: string;
  date?: string;
  groups: ReleaseGroup[];
  /** Set when there is nothing listed, e.g. "Behind-the-scenes improvements only." */
  note?: string;
}

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: ReleaseGroup | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      const [version = "", date] = line.slice(3).split(/\s+—\s+/);
      release = { version: version.trim(), date: date?.trim(), groups: [] };
      releases.push(release);
      group = null;
    } else if (!release) {
      continue; // the file's own heading and intro
    } else if (line.startsWith("### ")) {
      group = { title: line.slice(4).trim(), items: [] };
      release.groups.push(group);
    } else if (line.startsWith("- ") && group) {
      group.items.push(line.slice(2).trim());
    } else if (line && !group) {
      release.note = release.note ? `${release.note} ${line}` : line;
    }
  }
  return releases;
}

export const releases: Release[] = parseChangelog(text);

/** Where the "last version seen" is kept, to notice an update on launch. */
const SEEN_KEY = "spotifier.lastSeenVersion";

/**
 * Whether this launch is the first since an update.
 *
 * Records the running version as seen either way. A fresh install has nothing
 * recorded and is not an update: someone who just installed does not need
 * telling what changed since a version they never had.
 */
export function updatedSinceLastLaunch(version: string): boolean {
  let last: string | null = null;
  try {
    last = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    return false;
  }
  return last !== null && last !== version;
}
