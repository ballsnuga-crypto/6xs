require("dotenv").config();

const { URLSearchParams } = require("url");
const express = require("express");
const session = require("express-session");
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  PORT,
  SUPABASE_URL,
  SUPABASE_KEY,
  OAUTH2_LINK,
  PUBLIC_SITE_URL,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  DISCORD_GUILD_ID,
  NODE_ENV,
} = process.env;

/** Fixes copy-paste typos (e.g. stray spaces in Supabase hostname). */
function stripAllWhitespace(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

const VERIFY_CHANNEL_ID = "1498120494140887080";

/** Same redirect Discord uses on the authorize URL and on token exchange — must match byte-for-byte. */
const REDIRECT_URI_NORMALIZED = (REDIRECT_URI || "").trim();

function getSiteBaseUrl() {
  const raw = (PUBLIC_SITE_URL || "https://6xs.lol").replace(/\/$/, "");
  try {
    new URL(raw);
    return raw;
  } catch {
    return "https://6xs.lol";
  }
}

const SITE_BASE = getSiteBaseUrl();

function safeSiteHostname() {
  try {
    return new URL(SITE_BASE).hostname || "6xs.lol";
  } catch {
    return "6xs.lol";
  }
}

/** Built from CLIENT_ID + REDIRECT_URI so the button never disagrees with /callback token exchange. */
function buildDiscordAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI_NORMALIZED,
    scope: "identify guilds.join",
    prompt: "consent",
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/** Prefer env button URL only if it matches our redirect_uri (otherwise Discord token exchange fails). */
function effectiveOAuthLink() {
  const built = buildDiscordAuthorizeUrl();
  if (!OAUTH2_LINK || !OAUTH2_LINK.trim()) {
    return built;
  }
  const trimmed = OAUTH2_LINK.trim();
  try {
    const u = new URL(trimmed);
    const theirs = u.searchParams.get("redirect_uri") || "";
    const decoded = decodeURIComponent(theirs);
    if (decoded && decoded !== REDIRECT_URI_NORMALIZED) {
      console.warn(
        "[OAuth] OAUTH2_LINK redirect_uri does not match REDIRECT_URI — using built authorize URL so token exchange works."
      );
      return built;
    }
  } catch {
    console.warn("[OAuth] OAUTH2_LINK is not a valid URL — using built authorize URL.");
    return built;
  }
  return trimmed;
}

const OAUTH_LINK_EFFECTIVE = effectiveOAuthLink();

const SUPABASE_URL_CLEAN = stripAllWhitespace(SUPABASE_URL);
const SUPABASE_KEY_CLEAN = (SUPABASE_KEY || "").trim();

if (
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !BOT_TOKEN ||
  !REDIRECT_URI_NORMALIZED ||
  !SUPABASE_URL_CLEAN ||
  !SUPABASE_KEY_CLEAN
) {
  throw new Error("Missing required environment variables. Check your .env file.");
}

const supabase = createClient(SUPABASE_URL_CLEAN, SUPABASE_KEY_CLEAN);

console.log(
  `[OAuth] REDIRECT_URI used for token exchange & authorize button: ${REDIRECT_URI_NORMALIZED}`
);
console.log(`[OAuth] Verification button URL (effective): ${OAUTH_LINK_EFFECTIVE}`);
if (OAUTH2_LINK && OAUTH_LINK.trim() && OAUTH_LINK_EFFECTIVE !== OAUTH2_LINK.trim()) {
  console.warn(
    "[OAuth] Your OAUTH2_LINK disagrees with REDIRECT_URI or is invalid — the effective URL above is what users should use (http vs https must match REDIRECT_URI). Consider removing OAUTH2_LINK so the bot always builds from REDIRECT_URI."
  );
}

const app = express();
app.set("trust proxy", 1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sessionSecret = SESSION_SECRET || "";
if (!sessionSecret) {
  console.warn(
    "[admin] SESSION_SECRET is not set — /admin login will be disabled. Set SESSION_SECRET to a long random string."
  );
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    name: "6xs_admin",
    secret: sessionSecret || "insecure-dev-only",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function adminAuthOk() {
  const u = (ADMIN_USERNAME || "").trim();
  const p = ADMIN_PASSWORD || "";
  return Boolean(sessionSecret && u && p);
}

function isAdminSession(req) {
  return Boolean(req.session && req.session.admin === true);
}

async function fetchDiscordUserJson(userId) {
  try {
    const r = await fetch(`https://discord.com/api/users/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Re-add all backed-up OAuth users to a guild (same logic as !restore).
 * @returns {Promise<{ restoredCount: number, errors: string[] }>}
 */
async function restoreMembersToGuild(guildId) {
  const { data, error } = await supabase.from("discord_backups").select("user_id, access_token");
  if (error) {
    throw new Error(error.message);
  }

  let restoredCount = 0;
  const errors = [];

  for (const row of data || []) {
    const uid = String(row.user_id || "").trim();
    const token = String(row.access_token || "").trim();
    if (!uid || !token) {
      await sleep(2000);
      continue;
    }

    try {
      const resp = await fetch(
        `https://discord.com/api/guilds/${guildId}/members/${uid}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ access_token: token }),
        }
      );

      if (resp.ok || resp.status === 201 || resp.status === 204) {
        restoredCount += 1;
      } else {
        const body = await resp.text();
        errors.push(`${uid}: HTTP ${resp.status}`);
        console.error(`[Restore] Failed for user ${uid}: ${resp.status} ${body}`);
      }
    } catch (err) {
      errors.push(`${uid}: ${String(err)}`);
      console.error(`[Restore] Error for user ${uid}:`, err);
    }

    await sleep(2000);
  }

  return { restoredCount, errors };
}

function successLandingHtml(user) {
  const name = user?.global_name || user?.username || "there";
  const avatarUrl =
    user?.avatar &&
    `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verified — 6xs</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0c0d10;
      --card: #14161c;
      --border: #252830;
      --text: #e8eaed;
      --muted: #9aa0a6;
      --accent: #5865f2;
      --accent-dim: #4752c4;
      --ok: #3ba55d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "DM Sans", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background-image:
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(88, 101, 242, 0.22), transparent),
        radial-gradient(ellipse 60% 40% at 100% 100%, rgba(59, 165, 93, 0.08), transparent);
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px 28px;
      text-align: center;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ok);
      margin-bottom: 16px;
    }
    .badge svg { flex-shrink: 0; }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 8px;
      line-height: 1.25;
    }
    .sub {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.55;
      margin: 0 0 24px;
    }
    .avatar {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      margin: 0 auto 20px;
      border: 3px solid var(--border);
      object-fit: cover;
      background: var(--border);
    }
    .avatar.placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    a.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 18px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.95rem;
      text-decoration: none;
      transition: background 0.15s, transform 0.1s;
    }
    a.btn-primary {
      background: var(--accent);
      color: #fff;
    }
    a.btn-primary:hover {
      background: var(--accent-dim);
      transform: translateY(-1px);
    }
    a.btn-ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
    }
    a.btn-ghost:hover {
      color: var(--text);
      border-color: var(--muted);
    }
    footer {
      margin-top: 24px;
      font-size: 12px;
      color: var(--muted);
    }
    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11.67 3.5L5.25 9.92 2.33 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Backup linked
    </div>
    ${
      avatarUrl
        ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="" width="72" height="72" />`
        : `<div class="avatar placeholder">${escapeHtml(name.charAt(0).toUpperCase())}</div>`
    }
    <h1>You’re verified, ${escapeHtml(name)}</h1>
    <p class="sub">
      Your Discord account is connected for server backup &amp; restore.
      You can close this tab and return to the server.
    </p>
    <div class="actions">
      <a class="btn btn-primary" href="${escapeHtml(SITE_BASE)}/">Open ${escapeHtml(safeSiteHostname())}</a>
      <a class="btn btn-ghost" href="https://discord.com/channels/@me">Open Discord</a>
    </div>
    <footer>
      <a href="${escapeHtml(SITE_BASE)}/">6xs.lol</a> — archives &amp; community hub (login required for members).
    </footer>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).type("html").send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0c0d10;color:#e8eaed;"><p>Missing OAuth2 code.</p></body></html>`
    );
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: REDIRECT_URI_NORMALIZED,
    });

    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      throw new Error(`Token exchange failed: ${tokenResp.status} ${body}`);
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    const meResp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!meResp.ok) {
      const body = await meResp.text();
      throw new Error(`User fetch failed: ${meResp.status} ${body}`);
    }

    const me = await meResp.json();
    const userId = me.id;

    const { error } = await supabase.from("discord_backups").upsert(
      {
        user_id: userId,
        access_token: accessToken,
        refresh_token: refreshToken,
      },
      { onConflict: "user_id" }
    );

    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    return res.status(200).type("html").send(successLandingHtml(me));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error("[OAuth callback error]", msg);
    console.error(err);

    let hint =
      "Check the bot host logs for the exact error. Common fixes: match REDIRECT_URI to Discord Developer Portal exactly; use the service_role key for Supabase; ensure table discord_backups exists with a unique user_id.";
    if (msg.includes("Token exchange failed")) {
      hint =
        "Discord rejected the code — usually **redirect_uri mismatch** (must match Portal + .env exactly), **wrong client_secret**, or you **refreshed** this page (codes are one-time). Click Verify again from Discord.";
    } else if (msg.includes("Supabase") || msg.includes("supabase") || msg.includes("PGRST")) {
      hint =
        "Database save failed — use the **service_role** key (or fix RLS). Ensure table **discord_backups** has columns **user_id**, **access_token**, **refresh_token** and a unique constraint on **user_id**.";
    } else if (msg.includes("User fetch failed")) {
      hint = "Could not read your Discord profile after login — try again or check Discord status.";
    }

    const showDetail = process.env.OAUTH_DEBUG === "1";
    const detailBlock = showDetail
      ? `<pre style="white-space:pre-wrap;word-break:break-word;opacity:0.85;font-size:12px;margin-top:1rem;">${escapeHtml(
          msg
        )}</pre>`
      : "";

    return res.status(500).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OAuth error — 6xs</title>
</head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:520px;margin:0 auto;background:#0c0d10;color:#e8eaed;">
  <h1 style="margin-top:0;">Something went wrong</h1>
  <p>OAuth flow failed. ${escapeHtml(hint)}</p>
  ${detailBlock}
  <p style="margin-top:1.5rem;font-size:14px;color:#9aa0a6;">Set <code>OAUTH_DEBUG=1</code> on the server to show the raw error on this page (remove after fixing).</p>
</body>
</html>`);
  }
});

// ----- Admin dashboard (credentials from env only — never commit passwords) -----
function adminDisabledHtml(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — 6xs admin</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0c0d10; color: #e8eaed; padding: 2rem; max-width: 560px; margin: 0 auto; }
    a { color: #5865f2; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${body}</p>
</body>
</html>`;
}

function adminLoginHtml(err) {
  const errBlock = err
    ? `<p style="color:#ed4245">${escapeHtml(err)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin — 6xs</title>
  <style>
    body { font-family: "DM Sans", system-ui, sans-serif; background: #0c0d10; color: #e8eaed; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; margin: 0; }
    .card { background: #14161c; border: 1px solid #252830; border-radius: 16px; padding: 28px; width: 100%; max-width: 380px; box-sizing: border-box; }
    h1 { margin: 0 0 16px; font-size: 1.35rem; }
    label { display: block; font-size: 14px; color: #9aa0a6; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #252830; background: #0c0d10; color: #e8eaed; margin-bottom: 14px; box-sizing: border-box; }
    button { width: 100%; padding: 12px; border-radius: 10px; border: none; background: #5865f2; color: #fff; font-weight: 600; cursor: pointer; }
    button:hover { filter: brightness(1.08); }
  </style>
</head>
<body>
  <div class="card">
    <h1>6xs backup — admin</h1>
    ${errBlock}
    <form method="post" action="/admin/login">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    <p style="margin-top:14px;font-size:12px;color:#9aa0a6;">Set ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET on the server.</p>
  </div>
</body>
</html>`;
}

async function renderAdminDashboardHtml() {
  const { data, error } = await supabase.from("discord_backups").select("user_id").order("user_id");
  if (error) {
    throw new Error(error.message);
  }

  const rows = [];
  for (const r of data || []) {
    const uid = String(r.user_id || "");
    const du = uid ? await fetchDiscordUserJson(uid) : null;
    const displayName = du
      ? escapeHtml(du.global_name || du.username || "?")
      : "—";
    rows.push(
      `<tr><td style="padding:8px;font-family:monospace;font-size:13px">${escapeHtml(uid)}</td><td style="padding:8px">${displayName}</td></tr>`
    );
  }

  const guildHint = DISCORD_GUILD_ID
    ? escapeHtml(String(DISCORD_GUILD_ID))
    : '<span style="color:#ed4245">not set — add DISCORD_GUILD_ID</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OAuth backups — admin</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0c0d10; color: #e8eaed; padding: 24px; margin: 0; }
    .top { max-width: 960px; margin: 0 auto; }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; background: #14161c; border: 1px solid #252830; border-radius: 12px; overflow: hidden; }
    th { text-align: left; padding: 10px 12px; background: #1a1d26; font-size: 13px; color: #b5bac1; }
    .muted { color: #9aa0a6; font-size: 14px; margin-bottom: 20px; }
    .toolbar { margin-bottom: 18px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    button, .btn-link {
      padding: 10px 16px; border-radius: 10px; border: none; font-weight: 600; cursor: pointer; font-size: 14px;
      background: #5865f2; color: #fff; text-decoration: none; display: inline-block;
    }
    button.secondary { background: transparent; border: 1px solid #4e5058; color: #e8eaed; }
    button:hover, .btn-link:hover { filter: brightness(1.06); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="top">
    <h1>Verified OAuth backups</h1>
    <p class="muted">
      Users who completed the Discord OAuth flow are listed below. Restore uses each user’s saved access token and the bot token (same as <code>!restore</code> in Discord).
      Target guild ID: ${guildHint}
    </p>
    <div class="toolbar">
      <form method="post" action="/admin/restore" style="margin:0" id="restore-form">
        <button type="submit" ${!DISCORD_GUILD_ID ? "disabled" : ""}>Re-add all to server</button>
      </form>
      <form method="post" action="/admin/logout" style="margin:0">
        <button type="submit" class="secondary">Log out</button>
      </form>
      <a class="btn-link" href="${escapeHtml(SITE_BASE)}/">Back to site</a>
    </div>
    <table>
      <thead><tr><th>User ID</th><th>Name (bot lookup)</th></tr></thead>
      <tbody>${rows.length ? rows.join("") : '<tr><td colspan="2" style="padding:16px;color:#9aa0a6">No rows yet.</td></tr>'}</tbody>
    </table>
    <p class="muted" style="margin-top:16px;font-size:12px;">Restore waits 2 seconds between each member add (Discord rate limits).</p>
  </div>
</body>
</html>`;
}

app.get("/admin", async (req, res) => {
  if (!adminAuthOk()) {
    return res
      .status(503)
      .type("html")
      .send(
        adminDisabledHtml(
          "Admin unavailable",
          "Set <strong>SESSION_SECRET</strong>, <strong>ADMIN_USERNAME</strong>, and <strong>ADMIN_PASSWORD</strong> on the server."
        )
      );
  }
  if (!isAdminSession(req)) {
    return res.status(200).type("html").send(adminLoginHtml());
  }
  try {
    const html = await renderAdminDashboardHtml();
    return res.status(200).type("html").send(html);
  } catch (e) {
    console.error("[admin] dashboard", e);
    return res
      .status(500)
      .type("html")
      .send(
        adminDisabledHtml(
          "Dashboard error",
          `${escapeHtml(String(e.message || e))}`
        )
      );
  }
});

app.post("/admin/login", (req, res) => {
  if (!adminAuthOk()) {
    return res.status(503).send("Admin disabled");
  }
  const u = String(req.body.username || "").trim();
  const p = String(req.body.password || "");
  const ok =
    u === (ADMIN_USERNAME || "").trim() &&
    p === (ADMIN_PASSWORD || "");
  if (!ok) {
    return res.status(401).type("html").send(adminLoginHtml("Invalid username or password."));
  }
  req.session.admin = true;
  return res.redirect(302, "/admin");
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(302, "/admin");
  });
});

app.post("/admin/restore", async (req, res) => {
  if (!adminAuthOk() || !isAdminSession(req)) {
    return res.status(403).send("Forbidden");
  }
  const gid = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  if (!gid) {
    return res.status(400).type("html").send(
      adminDisabledHtml("Missing guild", "Set <strong>DISCORD_GUILD_ID</strong> to your Discord server ID, then try again.")
    );
  }
  try {
    const { restoredCount, errors } = await restoreMembersToGuild(gid);
    const errPreview =
      errors.length > 0
        ? `<p style="color:#ed4245;font-size:13px">${escapeHtml(errors.slice(0, 8).join("; "))}${
            errors.length > 8 ? " …" : ""
          }</p>`
        : "";
    return res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Restore done</title>
<style>body{font-family:system-ui,sans-serif;background:#0c0d10;color:#e8eaed;padding:2rem;max-width:520px;margin:0 auto}</style>
</head>
<body>
  <h1>Restore finished</h1>
  <p>Members restored this run: <strong>${restoredCount}</strong></p>
  ${errPreview}
  <p><a href="/admin" style="color:#5865f2">Back to admin list</a></p>
</body>
</html>`);
  } catch (e) {
    console.error("[admin] restore", e);
    return res.status(500).send(String(e.message || e));
  }
});

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function postVerificationEmbed() {
  try {
    const ch = await bot.channels.fetch(VERIFY_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) {
      console.error(`[VERIFY] Channel ${VERIFY_CHANNEL_ID} not found or not text based.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Verify to Backup Access")
      .setDescription(
        "Click **Verify Now** to link your Discord account for backup & restore. " +
          "After you authorize, you’ll see a confirmation page on **6xs.lol**."
      )
      .setColor(0x5865f2)
      .setFooter({ text: "6xs.lol · OAuth backup" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Verify Now").setStyle(ButtonStyle.Link).setURL(OAUTH_LINK_EFFECTIVE)
    );

    await ch.send({ embeds: [embed], components: [row] });
    console.log("[VERIFY] Verification embed with button posted.");
  } catch (err) {
    console.error("[VERIFY] Failed to post verification embed:", err);
  }
}

bot.once("ready", () => {
  console.log(`Bot online as ${bot.user.tag}`);
  void postVerificationEmbed();
});

bot.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (message.content.trim().toLowerCase() !== "!restore") return;

  const member = message.member;
  if (!member || !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply("Only server Administrators can use `!restore`.");
    return;
  }

  await message.channel.send("Restore started. Re-adding members from backup...");

  try {
    const { restoredCount } = await restoreMembersToGuild(message.guild.id);
    await message.channel.send(`Restore finished. Total members restored: ${restoredCount}`);
  } catch (err) {
    await message.channel.send(`Restore failed: ${err}`);
  }
});

bot.login(BOT_TOKEN);
app.listen(Number(PORT) || 50004, () => {
  console.log(`OAuth server listening on port ${Number(PORT) || 50004}`);
});
