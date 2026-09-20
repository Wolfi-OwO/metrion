import { Link } from 'react-router-dom';

/**
 * The wordmark: a pulse line (the thing this product draws) in the brand
 * colour, then the name. The mark is decorative - the link's accessible name
 * is the word - and the link is 44px tall on a phone.
 */
export function Brand() {
  return (
    <Link
      to="/"
      className="inline-flex min-h-11 items-center gap-2 text-heading font-semibold tracking-tight text-ink md:min-h-9"
    >
      <svg
        viewBox="0 0 20 20"
        width="20"
        height="20"
        aria-hidden="true"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1.5 10.5h4l2.5-6.5 4 12 2.5-5.5h4" />
      </svg>
      metrion
    </Link>
  );
}
