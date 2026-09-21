/**
 * Shared loading, empty and error surfaces.
 *
 * Every async view renders one of these rather than nothing. A blank region
 * reads as breakage, and an error without a next step is a dead end — so an
 * action is part of the shape rather than optional.
 */

export function PageState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="pagestate" role="status">
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {action ? (
        <button className="chip" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Matches the shelf layout so content arriving causes no layout shift. */
export function ShelfSkeleton({ cards = 5 }: { cards?: number }) {
  return (
    <section className="shelf">
      <div className="shelf__header">
        <div className="skeleton" style={{ width: 180, height: 24 }} />
      </div>
      <div className="shelf__row" style={{ "--card-count": cards } as React.CSSProperties}>
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="card">
            <div className="card__artwrap">
              <div className="skeleton" style={{ width: "100%", aspectRatio: "1" }} />
            </div>
            <div>
              <div className="skeleton skeleton--line" style={{ width: "80%" }} />
              <div className="skeleton skeleton--line" style={{ width: "55%" }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Matches the track table so a loading playlist keeps its final geometry. */
export function TrackListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading tracks">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="trackrow" style={{ gridTemplateColumns: "32px 1fr 80px" }}>
          <div className="skeleton" style={{ width: 16, height: 16 }} />
          <div className="trackrow__main">
            <div className="skeleton trackrow__art" />
            <div className="trackrow__text" style={{ width: "100%" }}>
              <div className="skeleton skeleton--line" style={{ width: "40%" }} />
              <div className="skeleton skeleton--line" style={{ width: "25%" }} />
            </div>
          </div>
          <div className="skeleton skeleton--line" style={{ width: 40 }} />
        </div>
      ))}
    </div>
  );
}
