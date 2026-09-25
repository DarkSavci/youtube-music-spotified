import { useEffect, useId, useState } from "react";
import { releases } from "../lib/changelog";
import { desktop } from "../lib/desktop";

/**
 * What's new: every release and what it changed, newest first.
 *
 * Built into the app from CHANGELOG.md, so it reads the same offline and
 * always describes the versions up to the one installed.
 */
export function Changelog({ limit, hideTitle = false }: { limit?: number; hideTitle?: boolean } = {}) {
  const id = useId();
  const [installed, setInstalled] = useState<string | null>(null);
  useEffect(() => {
    void desktop.version().then((v) => setInstalled(v?.version ?? null));
  }, []);

  return (
    <div className="changelog">
      {!hideTitle && <h1 className="changelog__title">What's new</h1>}
      {releases.length === 0 ? (
        <p className="changelog__empty">No release notes in this build.</p>
      ) : (
        releases.slice(0, limit).map((r) => (
          <section key={r.version} className="changelog__release" aria-labelledby={`${id}-v-${r.version}`}>
            <header className="changelog__header">
              <h2 id={`${id}-v-${r.version}`} className="changelog__version">
                {r.version}
              </h2>
              {r.version === installed ? <span className="changelog__badge">Installed</span> : null}
              {r.date ? <span className="changelog__date">{formatDate(r.date)}</span> : null}
            </header>
            {r.note ? <p className="changelog__note">{r.note}</p> : null}
            {r.groups.map((g) => (
              <div key={g.title} className="changelog__group">
                <h3 className="changelog__grouptitle" data-kind={g.title.toLowerCase()}>
                  {g.title}
                </h3>
                <ul className="changelog__items">
                  {g.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}
