/**
 * A skeleton block. The content is a non-breaking space, so a Ghost sitting in
 * a line of text takes exactly that line's height from the font and line-height
 * around it - the placeholder cannot be a pixel off the real text it stands in
 * for, which is what keeps the swap to real data from shifting anything. Give
 * it a width; give it `h-*`/`size-*` only when it stands in for a non-text box
 * (a sparkline, a button, a bar).
 */
export function Ghost({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`ghost ${className}`}>
      {' '}
    </span>
  );
}
