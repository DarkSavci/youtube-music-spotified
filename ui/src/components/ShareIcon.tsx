import { IconCopy, IconShare } from "./Icon";

/** Share copies a link; preview that action on hover and keyboard focus. */
export function ShareIcon({ size = 18 }: { size?: number }) {
  return <span className="share-icon" aria-hidden="true" style={{ width: size, height: size }}>
    <IconShare size={size} className="share-icon__share" />
    <IconCopy size={size} className="share-icon__copy" />
  </span>;
}
