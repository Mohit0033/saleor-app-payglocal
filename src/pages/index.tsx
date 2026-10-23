import { useEffect, useState } from "react";

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 640,
    margin: "0 auto",
    padding: "48px 24px",
    fontFamily: "system-ui, sans-serif",
    color: "#1A1A1A",
  },
  card: {
    border: "1px solid #E8E5DE",
    borderRadius: 12,
    padding: 24,
    background: "#FAFAF7",
  },
  pill: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid #D4AF37",
    color: "#8A6A14",
  },
  code: {
    fontFamily: "ui-monospace, monospace",
    fontSize: 13,
    background: "#FFF",
    border: "1px solid #EEE",
    borderRadius: 6,
    padding: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};

export default function HomePage() {
  const [origin, setOrigin] = useState(process.env.APP_URL || "");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return (
    <main style={styles.container}>
      <h1 style={{ fontSize: 24 }}>PayGlocal Payments</h1>
      <p style={{ color: "#666" }}>
        Saleor payment app — PayGlocal PayCollect hosted checkout (cards, UPI,
        net banking, Apple Pay, global alternative payment methods).
      </p>

      <div style={{ ...styles.card, marginTop: 24 }}>
        <p style={{ marginTop: 0 }}>
          <span style={styles.pill}>PayCollect · hosted page</span>{" "}
          <span style={styles.pill}>{process.env.PAYGLOCAL_API_BASE?.includes("uat") ? "UAT sandbox" : "production"}</span>
        </p>
        <h3 style={{ marginBottom: 4 }}>Install</h3>
        <p style={{ color: "#666" }}>
          In the Saleor dashboard go to <b>Apps → Add app</b> and paste the
          manifest URL:
        </p>
        <pre style={styles.code}>{origin ? `${origin}/api/manifest` : "<APP_URL>/api/manifest"}</pre>
        <h3 style={{ marginBottom: 4 }}>Endpoints</h3>
        <p style={{ color: "#666", marginTop: 0 }}>
          <code>/api/manifest</code> — app manifest<br />
          <code>/api/register</code> — install handshake<br />
          <code>/api/webhooks/transaction-initialize-session</code> — starts the
          hosted sale<br />
          <code>/api/webhooks/transaction-process-session</code> — status /
          redirect / charge confirmation<br />
          <code>/api/payglocal/callback</code> — PayGlocal
          <i> merchantCallbackURL</i> (independent webhook, no Saleor JWT)
        </p>
        <p style={{ color: "#8A3B2A", fontWeight: 500 }}>
          Required env: PAYGLOCAL_MID, PAYGLOCAL_KID, PAYGLOCAL_PRIVATE_KEY,
          PAYGLOCAL_API_BASE, APP_URL, STOREFRONT_URL (see .env.example).
        </p>
      </div>
    </main>
  );
}
