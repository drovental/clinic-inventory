// One-time helper: get a Gmail refresh token for the Alma IQ mailbox.
// Usage:  node gmail-auth.js   (client_secret.json must be in the same folder)
// Opens a browser; sign in with ariaclinic10@gmail.com and approve. Writes gmail-oauth.json next to this file.
const http = require("http"); const { exec } = require("child_process"); const fs = require("fs");
// Reads client_secret.json (downloaded from Google Cloud) next to this file
const cs = JSON.parse(fs.readFileSync(require("path").join(__dirname, "client_secret.json"), "utf8"));
const { client_id: clientId, client_secret: clientSecret } = cs.installed || cs.web || cs;
if (!clientId || !clientSecret) { console.error("client_secret.json missing client_id/client_secret"); process.exit(1); }
const port = 8765, redirect = `http://localhost:${port}/`;
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent",
  scope: "https://www.googleapis.com/auth/gmail.modify", login_hint: "ariaclinic10@gmail.com",
});
const srv = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("no code"); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }) });
  const j = await r.json();
  if (!j.refresh_token) { res.end("failed: " + JSON.stringify(j)); console.error(j); process.exit(1); }
  fs.writeFileSync("gmail-oauth.json", JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: j.refresh_token }));
  res.end("<h2>Done – you can close this window</h2>");
  console.log("OK: gmail-oauth.json written");
  setTimeout(() => process.exit(0), 500);
});
srv.listen(port, () => { console.log("Opening browser..."); exec(`start "" "${url}"`); console.log("If the browser did not open, visit:\n" + url); });
