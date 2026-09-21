import { useId } from "react";

interface SliderProps {
  value: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  /** Step for keyboard adjustment. Defaults to 1% of the range. */
  step?: number;
}

/**
 * A range input with a painted track.
 *
 * The native input is kept, stretched over the visual and made transparent,
 * rather than reimplemented with pointer handlers. That is what buys keyboard
 * operation, screen-reader semantics and OS-level assistive behaviour for free
 * — all of which a div-based slider has to rebuild, usually incompletely.
 */
export function Slider({
  value,
  max,
  onChange,
  label,
  className = "",
  disabled = false,
  step,
}: SliderProps) {
  const id = useId();
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));

  return (
    <div className={`slider ${className}`} data-disabled={disabled || undefined}>
      <div className="slider__track">
        <div className="slider__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="slider__thumb" style={{ left: `${pct}%` }} />
      <input
        id={id}
        type="range"
        min={0}
        max={safeMax}
        step={step ?? safeMax / 100}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
