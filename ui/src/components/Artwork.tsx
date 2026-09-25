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
  if (!src || failed === src)
    return fallback !== undefined ? (
      <>{fallback}</>
    ) : (
      <span
        className={`${className || ""} artwork-fallback`}
        role="img"
        aria-label="Artwork unavailable"
      >
        <IconAlbum size={24} />
      </span>
    );
  return (
    <img
      {...props}
      className={className}
      src={src}
      onError={() => setFailed(src)}
    />
  );
}
