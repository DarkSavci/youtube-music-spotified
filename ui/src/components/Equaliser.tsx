import { EQ_BANDS } from "../lib/decks";
import { useSettings } from "../lib/settings";
import { usePlayer } from "../lib/player";

/**
 * A five-band equaliser.
 *
 * The engine advertised this capability for a long time with nothing behind
 * it. Five bands rather than ten because the point is a usable tone control,
 * and each band is another filter in series on every sample.
 *
 * Hidden when the active engine cannot do it: the embedded player has no Web
 * Audio graph, so the sliders would move and change nothing.
 */
const PRESETS: { name: string; gains: number[] }[] = [
  { name: "Flat", gains: [0, 0, 0, 0, 0] },
  { name: "Bass boost", gains: [6, 3, 0, 0, 1] },
  { name: "Vocal", gains: [-2, 0, 4, 3, 0] },
  { name: "Treble", gains: [-1, 0, 0, 3, 6] },
];

function label(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

export function Equaliser() {
  const eq = useSettings((s) => s.eq);
  const set = useSettings((s) => s.set);
  // This device's engine, not the session's capabilities: an equaliser is a
  // property of the audio graph here.
  const canEq = usePlayer((s) => s.engineEq);

  if (!canEq) {
    return (
      <p className="settings__hint">
        The current playback engine has no audio graph, so it cannot equalise.
      </p>
    );
  }

  const gains = EQ_BANDS.map((_, i) => eq[i] ?? 0);
  const update = (i: number, v: number) => {
    const next = [...gains];
    next[i] = v;
    set("eq", next);
  };

  return (
    <div className="eq">
      <div className="eq__bands">
        {EQ_BANDS.map((hz, i) => (
          <label key={hz} className="eq__band">
            <input
              type="range"
              min={-12}
              max={12}
              step={1}
              value={gains[i]}
              aria-label={`${label(hz)} hertz`}
              onChange={(e) => update(i, Number(e.target.value))}
            />
            <span className="eq__hz">{label(hz)}</span>
            <span className="eq__db">
              {gains[i]! > 0 ? `+${gains[i]}` : gains[i]}
            </span>
          </label>
        ))}
      </div>

      <div className="eq__presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className="chip"
            aria-pressed={p.gains.every((g, i) => g === gains[i])}
            onClick={() => set("eq", [...p.gains])}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
