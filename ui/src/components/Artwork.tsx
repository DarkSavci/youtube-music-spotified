import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { IconAlbum } from "./Icon";
/** Missing/expired artwork should never display a browser broken-image glyph. */
export function Artwork({
  src,
  className,
  fallback,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  /** Shown instead of the album glyph, e.g. a listener's initial. */
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src) {
    if (fallback !== undefined) return <>{fallback}</>;
    // Decorative artwork (alt="" or hidden) stays silent when it is missing
    // too; otherwise the placeholder says what is missing.
    const decorative = props.alt === "" || props["aria-hidden"] === true || props["aria-hidden"] === "true";
    return (
      <span
        className={`${className || ""} artwork-fallback`}
        {...(decorative
          ? { "aria-hidden": true }
          : { role: "img", "aria-label": props.alt || "Artwork unavailable" })}
      >
        <IconAlbum size={24} />
      </span>
    );
  }
  return (
    <img
      {...props}
      className={className}
      src={src}
      onError={() => setFailed(src)}
    />
  );
}
