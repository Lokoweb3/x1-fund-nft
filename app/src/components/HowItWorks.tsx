import { useState } from "react";
import { loadSetting, saveSetting } from "../lib/network";

const KEY = "how-it-works";

/** First-run explainer. Dismissal is a per-browser convenience (localStorage, wrapped in try/catch by load/saveSetting). */
export function HowItWorks() {
  const [dismissed, setDismissed] = useState(() => loadSetting<{ dismissed: boolean }>(KEY, { dismissed: false }).dismissed);
  if (dismissed) return null;
  return (
    <section className="panel how" data-testid="how-it-works">
      <div className="row between">
        <h2>How it works</h2>
        <button
          className="link"
          data-testid="dismiss-how"
          onClick={() => {
            setDismissed(true);
            saveSetting(KEY, { dismissed: true });
          }}
        >
          dismiss
        </button>
      </div>
      <ol className="small">
        <li>
          <strong>Create a fund.</strong> Choose the token you pay with (for example USDC.X), the tokens to buy and their shares, and how much to
          spend how often.
        </li>
        <li>
          <strong>You get an NFT that owns it.</strong> Give it a name and a picture. Whoever holds the NFT can withdraw; there is no other
          owner and no admin.
        </li>
        <li>
          <strong>Deposit.</strong> A keeper (any bot) runs each due buy through the fund's XDEX pool for a 0.1% tip. A buy is refused if the
          price is too far from the recent average.
        </li>
        <li>
          <strong>Withdraw any time</strong>, in the tokens the fund holds. Every step is simulated and shown to you before your wallet signs.
        </li>
      </ol>
    </section>
  );
}
