import type { JSX, ReactNode } from 'react';
import { shortCredits, type Credit } from '../lib/credits';

function CreditItem({ c, showFiles }: { c: Credit; showFiles: boolean }): JSX.Element {
  return (
    <li>
      <strong>
        {c.url ? (
          <a href={c.url} target="_blank" rel="noreferrer">
            {c.name}
          </a>
        ) : (
          c.name
        )}
      </strong>
      {c.use ? ` (${c.use})` : ''}
      {c.licence ? ` · ${c.licence}` : ''}
      {c.citation ? ` · ${c.citation}` : ''}
      {showFiles && c.files.length > 0 && <span className="faint"> ({c.files.join(', ')})</span>}
    </li>
  );
}

/** The full credits panel: one list for every screen that shows one. */
export function CreditsPanel({
  credits,
  id,
  intro,
  children,
}: {
  credits: Credit[];
  id: string;
  intro?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const main = credits.filter((c: Credit): boolean => !c.key.startsWith('x:'));
  const extra = credits.filter((c: Credit): boolean => c.key.startsWith('x:'));
  return (
    <section className="panel panel-pad credits" aria-labelledby={id}>
      <h2 id={id}>Data credits and licences</h2>
      {intro && <p className="caption">{intro}</p>}
      <ul>
        {main.map((c: Credit) => (
          <CreditItem key={c.key} c={c} showFiles />
        ))}
        {children}
      </ul>
      {extra.length > 0 && (
        <>
          <h3 className="credits-sub">Also cited in the data files</h3>
          <ul>
            {extra.map((c: Credit) => (
              <CreditItem key={c.key} c={c} showFiles />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** One line in the footer of every screen, with the full list on demand. */
export function FooterCredits({ credits }: { credits: Credit[] }): JSX.Element {
  return (
    <details className="footer-credits">
      <summary>
        Data: {shortCredits(credits).join(' · ')} <span className="footer-credits-more">credits and licences</span>
      </summary>
      <ul>
        {credits.map((c: Credit) => (
          <CreditItem key={c.key} c={c} showFiles={false} />
        ))}
      </ul>
    </details>
  );
}
