import { useState, type ImgHTMLAttributes } from "react";
import { IconAlbum } from "./Icon";
/** Missing/expired artwork should never display a browser broken-image glyph. */
export function Artwork({
  src,
  className,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src)
    return (
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
