import { Link } from 'react-router-dom';

/** The wordmark, linked home. `/` decides landing vs. dashboard itself
 * (`routes/root.tsx`), so this never has to know which one it is pointing
 * at. */
export function Brand() {
  return (
    <Link to="/" className="font-mono text-heading font-semibold tracking-tight text-ink">
      metrion
    </Link>
  );
}
