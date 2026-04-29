require("dotenv").config();

const { URLSearchParams } = require("url");
const express = require("express");
const { attachArchiveSystem } = require("./archiveSystem");
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
  VERIFY_ACCESS_ROLE_ID,
} = process.env;

/** After OAuth, assign this role in DISCORD_GUILD_ID (user must be joinable or already in guild). */
const VERIFY_ACCESS_ROLE_ID_NORMALIZED = (
  VERIFY_ACCESS_ROLE_ID || "1498451320284119252"
).trim();
const FEMALE_ROLE_ID = "1498121622438019183";
const MALE_ROLE_ID = "1498668504641961994";
const AGE_OPTIONS = [...Array(13).keys()].map((n) => String(13 + n)).concat("25+");

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

/** Archive site login (/auth/login) — must be added as its own redirect URL in Discord (separate from backup /callback). */
const SITE_AUTH_REDIRECT_NORMALIZED =
  (process.env.SITE_AUTH_REDIRECT_URI || "").trim() ||
  `${SITE_BASE}/auth/callback`;

const ARCHIVE_CHANNEL_IDS = (
  process.env.ARCHIVE_CHANNEL_IDS || "1498122216800522261,1498278738096295936,1498521334198702223"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Labels for archive UI tabs */
const CHANNEL_LABELS = {
  "1498122216800522261": "#general",
  "1498278738096295936": "#tcc",
  "1498521334198702223": "#blood",
};

const MEDIA_ARCHIVE_CHANNEL_ID = "1498521334198702223";
if (!ARCHIVE_CHANNEL_IDS.includes(MEDIA_ARCHIVE_CHANNEL_ID)) {
  ARCHIVE_CHANNEL_IDS.push(MEDIA_ARCHIVE_CHANNEL_ID);
}
const CHANNEL_NUKE_INTERVAL_MS = {
  [MEDIA_ARCHIVE_CHANNEL_ID]: 30 * 60 * 1000,
};
const DEFAULT_NUKE_INTERVAL_MS = Math.max(
  60000,
  parseInt(process.env.NUKE_INTERVAL_MS || `${24 * 60 * 60 * 1000}`, 10) || 86400000
);
const MEDIA_BACKUP_ENABLED = String(process.env.ARCHIVE_MEDIA_BACKUP_ENABLED || "1").trim() !== "0";
const MEDIA_BACKUP_BUCKET = String(process.env.ARCHIVE_MEDIA_BUCKET || "archive-media").trim() || "archive-media";
const MEDIA_BACKUP_MAX_BYTES = Math.max(
  1024 * 1024,
  parseInt(process.env.ARCHIVE_MEDIA_MAX_BYTES || `${125 * 1024 * 1024}`, 10) || 125 * 1024 * 1024
);
const BUNNY_STORAGE_ENDPOINT = String(process.env.BUNNY_STORAGE_ENDPOINT || "").trim();
const BUNNY_STORAGE_ACCESS_KEY = String(process.env.BUNNY_STORAGE_ACCESS_KEY || "").trim();
const BUNNY_CDN_BASE = String(process.env.BUNNY_CDN_BASE || "").trim();

function safeSiteHostname() {
  try {
    return new URL(SITE_BASE).hostname || "6xs.lol";
  } catch {
    return "6xs.lol";
  }
}

function getAgeRoleId(ageChoice) {
  const raw = String(ageChoice || "").trim();
  if (raw === "25+") return String(process.env.AGE_ROLE_ID_25_PLUS || "").trim();
  if (!/^(1[3-9]|2[0-5])$/.test(raw)) return "";
  return String(process.env[`AGE_ROLE_ID_${raw}`] || "").trim();
}

async function fetchGuildRoles() {
  const guildId = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  if (!guildId) return [];
  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function resolveAgeRoleId(ageChoice) {
  const configured = getAgeRoleId(ageChoice);
  if (configured) return configured;
  const target = String(ageChoice || "").trim().toLowerCase();
  const roles = await fetchGuildRoles();
  const exact = roles.find((r) => String(r?.name || "").trim().toLowerCase() === target);
  return exact?.id ? String(exact.id) : "";
}

async function resolveGenderRoleId(genderChoice) {
  const g = String(genderChoice || "").toLowerCase();
  const configured = g === "male" ? MALE_ROLE_ID : FEMALE_ROLE_ID;
  if (configured) return configured;
  const roles = await fetchGuildRoles();
  const exact = roles.find((r) => String(r?.name || "").trim().toLowerCase() === g);
  return exact?.id ? String(exact.id) : "";
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
console.log("");
console.log(
  "[OAuth] If Discord says **Invalid OAuth2 redirect_uri**, add BOTH strings below → Developer Portal → your app → OAuth2 → Redirects (exact match — scheme, hostname, path, no extra slash):"
);
console.log(`  (1) Backup verify + /callback handler: ${REDIRECT_URI_NORMALIZED}`);
console.log(`  (2) Archive site login (Log in at 6xs):         ${SITE_AUTH_REDIRECT_NORMALIZED}`);
console.log("");
if (OAUTH2_LINK && OAUTH2_LINK.trim() && OAUTH_LINK_EFFECTIVE !== OAUTH2_LINK.trim()) {
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

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Ensure user is in the guild (OAuth `guilds.join` + bot in server), then add verified access role.
 * Does not throw — logs warnings so OAuth success page still shows if DB saved.
 */
async function grantVerifiedServerAccess(userId, oauthAccessToken) {
  const guildId = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  const roleId = VERIFY_ACCESS_ROLE_ID_NORMALIZED;
  if (!guildId || !roleId) {
    console.warn("[OAuth] Skipping role grant: set DISCORD_GUILD_ID (and optionally VERIFY_ACCESS_ROLE_ID).");
    return;
  }

  const headers = { Authorization: `Bot ${BOT_TOKEN}` };

  try {
    const addMemberResp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: oauthAccessToken }),
    });

    if (!addMemberResp.ok && addMemberResp.status !== 204) {
      const txt = await addMemberResp.text();
      if (addMemberResp.status !== 400 || !/already/i.test(txt)) {
        console.warn(
          `[OAuth] Add guild member ${userId} → ${addMemberResp.status} ${txt.slice(0, 200)}`
        );
      }
    }
  } catch (e) {
    console.warn(`[OAuth] Add guild member failed: ${e}`);
  }

  try {
    const roleResp = await fetch(
      `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      { method: "PUT", headers }
    );
    if (!roleResp.ok && roleResp.status !== 204) {
      const txt = await roleResp.text();
      console.warn(
        `[OAuth] Assign role ${roleId} to ${userId} → ${roleResp.status} ${txt.slice(0, 200)} (bot needs Manage Roles; role must be below bot.)`
      );
    }
  } catch (e) {
    console.warn(`[OAuth] Assign role failed: ${e}`);
  }
}

async function addRoleToMember(userId, roleId) {
  const guildId = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  const rid = String(roleId || "").trim();
  if (!guildId || !rid) return false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${rid}`, {
        method: "PUT",
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      });
      if (resp.ok || resp.status === 204) return true;
      const txt = await resp.text().catch(() => "");
      const shouldRetry = resp.status === 404 || resp.status === 429 || resp.status >= 500;
      if (!shouldRetry || attempt === 6) {
        console.warn(`[OAuth] add role ${rid} to ${userId} failed: ${resp.status} ${txt.slice(0, 160)}`);
        return false;
      }
    } catch (e) {
      if (attempt === 6) {
        console.warn(`[OAuth] add role ${rid} failed: ${e}`);
        return false;
      }
    }
    await sleep(900);
  }
  return false;
}

async function removeRoleFromMember(userId, roleId) {
  const guildId = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  const rid = String(roleId || "").trim();
  if (!guildId || !rid) return false;
  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${rid}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
      const txt = await resp.text().catch(() => "");
      console.warn(`[OAuth] remove role ${rid} from ${userId} failed: ${resp.status} ${txt.slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[OAuth] remove role ${rid} failed: ${e}`);
    return false;
  }
}

async function assignGenderAndAgeRoles(userId, genderChoice, ageChoice) {
  const gender = String(genderChoice || "").toLowerCase();
  const age = String(ageChoice || "").trim();

  if (gender !== "male" && gender !== "female") {
    throw new Error("Invalid gender choice.");
  }
  if (!AGE_OPTIONS.includes(age)) {
    throw new Error("Invalid age choice.");
  }

  const genderRole = await resolveGenderRoleId(gender);
  const oppositeGenderRole = await resolveGenderRoleId(gender === "male" ? "female" : "male");
  const ageRole = await resolveAgeRoleId(age);

  if (!genderRole) {
    throw new Error(`Gender role for '${gender}' is not configured/found.`);
  }

  if (oppositeGenderRole) await removeRoleFromMember(userId, oppositeGenderRole);
  const genderOk = await addRoleToMember(userId, genderRole);
  if (!genderOk) {
    throw new Error("Could not assign your gender role. Ensure bot role is above target roles and has Manage Roles.");
  }
  if (ageRole) {
    const ageOk = await addRoleToMember(userId, ageRole);
    if (!ageOk) {
      throw new Error(`Could not assign age role (${age}). Check role hierarchy/permissions.`);
    }
  } else {
    console.warn(`[OAuth] age role not configured for age '${age}' (set AGE_ROLE_ID_${age === "25+" ? "25_PLUS" : age})`);
  }
}

async function removeVerifiedRole(userId) {
  const guildId = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  const roleId = VERIFY_ACCESS_ROLE_ID_NORMALIZED;
  if (!guildId || !roleId) return;

  try {
    const resp = await fetch(
      `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      }
    );
    if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
      const body = await resp.text();
      console.warn(`[OAuth audit] role remove failed for ${userId}: ${resp.status} ${body.slice(0, 180)}`);
    }
  } catch (e) {
    console.warn(`[OAuth audit] role remove request failed for ${userId}: ${e}`);
  }
}

async function dmReauthorizeNotice(userId) {
  try {
    const user = await bot.users.fetch(String(userId));
    if (!user) return;
    await user.send(
      `Your 6xs verification expired or was revoked, so your access role was removed.\n\nPlease reauthorize here to restore access:\n${OAUTH_LINK_EFFECTIVE}`
    );
  } catch (e) {
    console.warn(`[OAuth audit] DM failed for ${userId}: ${e}`);
  }
}

async function isOAuthTokenRevoked(accessToken) {
  try {
    const resp = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function runOAuthRevocationAuditOnce() {
  const { data, error } = await supabase
    .from("discord_backups")
    .select("user_id, access_token");
  if (error) {
    console.warn(`[OAuth audit] read failed: ${error.message}`);
    return;
  }

  let revokedCount = 0;
  for (const row of data || []) {
    const uid = String(row.user_id || "").trim();
    const token = String(row.access_token || "").trim();
    if (!uid || !token) continue;

    const revoked = await isOAuthTokenRevoked(token);
    if (!revoked) {
      await sleep(350);
      continue;
    }

    revokedCount += 1;
    console.log(`[OAuth audit] revoked token detected for ${uid}; removing role + backup row + DM`);
    await removeVerifiedRole(uid);
    await dmReauthorizeNotice(uid);

    const { error: delErr } = await supabase
      .from("discord_backups")
      .delete()
      .eq("user_id", uid);
    if (delErr) {
      console.warn(`[OAuth audit] delete backup row failed for ${uid}: ${delErr.message}`);
    }

    await sleep(800);
  }
  if (revokedCount > 0) {
    console.log(`[OAuth audit] completed: ${revokedCount} revoked account(s) processed`);
  }
}

function startOAuthRevocationAuditLoop() {
  const minutesRaw = parseInt(process.env.OAUTH_AUDIT_INTERVAL_MINUTES || "30", 10);
  const minutes = Number.isFinite(minutesRaw) ? Math.max(5, minutesRaw) : 30;
  const intervalMs = minutes * 60 * 1000;
  console.log(`[OAuth audit] enabled: every ${minutes} minute(s)`);

  // Run once shortly after startup, then on interval.
  setTimeout(() => {
    void runOAuthRevocationAuditOnce();
  }, 15_000);
  setInterval(() => {
    void runOAuthRevocationAuditOnce();
  }, intervalMs);
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

function profileIntakeHtml(user, errorMessage = "") {
  const name = user?.global_name || user?.username || "there";
  const ageOptionsHtml = AGE_OPTIONS.map((a) => `<option value="${a}">${a}</option>`).join("");
  const err = errorMessage
    ? `<p style="background:#3a1b24;border:1px solid #703042;color:#ffd7de;border-radius:10px;padding:10px 12px;margin:0 0 14px;">${escapeHtml(errorMessage)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>One more step — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --card:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --accent:#5865f2; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; }
    .card { width:100%; max-width:460px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
    h1 { margin:0 0 8px; font-size:1.4rem; }
    p { color:var(--muted); margin:0 0 14px; line-height:1.45; }
    label { display:block; margin:12px 0 6px; font-size:13px; color:#c6c8ce; }
    select, .group { width:100%; background:#1e2128; border:1px solid var(--border); color:var(--text); border-radius:10px; padding:10px; }
    .group { display:flex; gap:10px; justify-content:space-between; }
    .btn { width:100%; margin-top:16px; border:none; border-radius:10px; padding:11px; font-weight:700; background:var(--accent); color:#fff; cursor:pointer; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/callback/profile">
    <h1>One more step, ${escapeHtml(name)}</h1>
    <p>Select your gender and age to finish verification and get your roles.</p>
    ${err}
    <label>Gender</label>
    <div class="group">
      <label style="margin:0"><input type="radio" name="gender" value="male" required /> Male</label>
      <label style="margin:0"><input type="radio" name="gender" value="female" required /> Female</label>
    </div>
    <label for="age">Age</label>
    <select id="age" name="age" required>
      <option value="" disabled selected>Select age</option>
      ${ageOptionsHtml}
    </select>
    <button class="btn" type="submit">Finish verification</button>
  </form>
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

    req.session.verifyProfile = {
      userId,
      accessToken,
      me: {
        id: me.id,
        username: me.username,
        global_name: me.global_name,
        avatar: me.avatar,
      },
    };

    return res.status(200).type("html").send(profileIntakeHtml(me));
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

app.post("/callback/profile", async (req, res) => {
  const st = req.session?.verifyProfile;
  if (!st?.userId || !st?.accessToken) {
    return res.status(400).type("html").send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0c0d10;color:#e8eaed;">Session expired. Click verify again from Discord.</body></html>`
    );
  }
  const gender = String(req.body?.gender || "").trim().toLowerCase();
  const age = String(req.body?.age || "").trim();
  if (!["male", "female"].includes(gender) || !AGE_OPTIONS.includes(age)) {
    return res.status(400).type("html").send(profileIntakeHtml(st.me || {}, "Please pick a valid gender and age."));
  }

  try {
    await grantVerifiedServerAccess(st.userId, st.accessToken);
    await assignGenderAndAgeRoles(st.userId, gender, age);
    delete req.session.verifyProfile;
    return res.status(200).type("html").send(successLandingHtml(st.me || {}));
  } catch (e) {
    console.error("[OAuth profile submit]", e);
    return res
      .status(500)
      .type("html")
      .send(profileIntakeHtml(st.me || {}, "Could not assign roles. Check bot role permissions and try again."));
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
    a.btn-link.secondary { background: transparent; border: 1px solid #4e5058; color: #e8eaed; padding: 10px 16px; }
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
      <a class="btn-link secondary" href="/admin/access-logs">Archive IPs / access log</a>
      <a class="btn-link secondary" href="/admin/discord-tools">Discord user check</a>
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

app.get("/admin/access-logs", async (req, res) => {
  if (!adminAuthOk()) {
    return res.status(503).type("html").send(adminDisabledHtml("Admin unavailable", "Configure admin env vars."));
  }
  if (!isAdminSession(req)) return res.redirect(302, "/admin");
  try {
    const { data, error } = await supabase
      .from("archive_access_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(250);
    if (error) throw new Error(error.message);
    const rows = (data || [])
      .map(
        (r) =>
          `<tr><td style="padding:6px;font-size:11px">${escapeHtml(String(r.created_at || ""))}</td>` +
          `<td style="padding:6px;font-family:monospace;font-size:12px">${escapeHtml(String(r.discord_user_id || "—"))}</td>` +
          `<td style="padding:6px;font-size:12px">${escapeHtml(String(r.ip || ""))}</td>` +
          `<td style="padding:6px;font-size:11px">${escapeHtml(String(r.path || ""))}</td>` +
          `<td style="padding:6px;font-size:11px">${escapeHtml(String(r.note || ""))}</td></tr>`
      )
      .join("");
    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Access logs</title>
<style>
body{font-family:system-ui,sans-serif;background:#0c0d10;color:#e8eaed;padding:20px;margin:0;}
table{width:100%;border-collapse:collapse;background:#14161c;border:1px solid #252830;border-radius:12px;}
th{text-align:left;padding:8px;background:#1a1d26;font-size:12px;}
td{border-top:1px solid #252830;}
a{color:#5865f2}
.muted{color:#9aa0a6;font-size:13px;margin-bottom:12px;}
</style></head><body>
<h1>Archive / site access logs</h1>
<p class="muted">IPs come from proxy headers (<code>X-Forwarded-For</code>) when available. Logs login attempts and archive views.</p>
<p><a href="/admin">← OAuth admin</a></p>
<table><thead><tr><th>Time</th><th>Discord user</th><th>IP</th><th>Path</th><th>Note</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No rows yet — ensure <code>archive_access_logs</code> exists (see supabase_archive.sql).</td></tr>'}</tbody></table>
</body></html>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get("/admin/discord-tools", (req, res) => {
  if (!adminAuthOk()) return res.status(503).send("Admin disabled");
  if (!isAdminSession(req)) return res.redirect(302, "/admin");
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Discord user check</title>
<style>
body{font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:20px;max-width:720px;margin:0 auto;}
label{display:block;margin-bottom:6px;color:#b5bac1;font-size:14px;}
input{width:100%;padding:10px;border-radius:8px;border:1px solid #252830;background:#14161c;color:#e8eaed;margin-bottom:14px;}
button{padding:10px 18px;border-radius:10px;border:none;background:#5865f2;color:#fff;font-weight:600;cursor:pointer;}
pre{background:#14161c;padding:14px;border-radius:10px;overflow:auto;font-size:12px;border:1px solid #252830;}
a{color:#5865f2}
</style></head><body>
<h1>Discord user check</h1>
<p style="color:#9aa0a6;font-size:14px;">Uses the bot token to resolve a user and guild membership (join eligibility is inferred from account state / flags).</p>
<p><a href="/admin">← Back</a></p>
<form method="post" action="/admin/discord-tools">
<label for="uid">Discord user ID (snowflake)</label>
<input id="uid" name="user_id" placeholder="e.g. 123456789012345678" required />
<button type="submit">Lookup</button>
</form>
</body></html>`);
});

app.post("/admin/discord-tools", async (req, res) => {
  if (!adminAuthOk() || !isAdminSession(req)) return res.status(403).send("Forbidden");
  const uid = String(req.body.user_id || "").trim();
  if (!/^\d{10,22}$/.test(uid)) {
    return res.status(400).send("Invalid snowflake");
  }
  const gid = DISCORD_GUILD_ID ? String(DISCORD_GUILD_ID).trim() : "";
  try {
    const userR = await fetch(`${DISCORD_API}/users/${uid}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    const userText = await userR.text();
    let userJson = null;
    try {
      userJson = JSON.parse(userText);
    } catch {
      userJson = null;
    }

    let memberBlock = "<p><em>Set DISCORD_GUILD_ID for membership check.</em></p>";
    if (gid) {
      const memR = await fetch(`${DISCORD_API}/guilds/${gid}/members/${uid}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      });
      const mt = await memR.text();
      memberBlock =
        `<h2>Guild member (${escapeHtml(gid)})</h2>` +
        `<pre>${escapeHtml(mt.slice(0, 4000))}</pre>` +
        `<p>HTTP status: ${memR.status}</p>`;
    }

    const flags = userJson?.public_flags ?? userJson?.flags ?? "—";
    const verified = userJson?.verified !== undefined ? String(userJson.verified) : "—";

    res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Lookup</title>
<style>body{font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:20px;max-width:800px;margin:0 auto;} pre{background:#14161c;padding:14px;border-radius:10px;overflow:auto;font-size:12px;} a{color:#5865f2}</style></head><body>
<h1>User ${escapeHtml(uid)}</h1>
<p><a href="/admin/discord-tools">← Another lookup</a></p>
<h2>Global user (bot REST)</h2>
<pre>${escapeHtml(userText.slice(0, 6000))}</pre>
<p>Public flags / account metadata: flags=<strong>${escapeHtml(String(flags))}</strong>, verified=<strong>${escapeHtml(verified)}</strong></p>
${memberBlock}
<p style="color:#9aa0a6;font-size:12px;">Banned users may still resolve via API; joining servers depends on invite, bans, verification level, etc.</p>
</body></html>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
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
    GatewayIntentBits.GuildMembers,
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

attachArchiveSystem({
  app,
  bot,
  supabase,
  SITE_BASE,
  ARCHIVE_GUILD_ID: String(DISCORD_GUILD_ID || "").trim(),
  ARCHIVE_CHANNEL_IDS,
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  SITE_AUTH_REDIRECT_URI: SITE_AUTH_REDIRECT_NORMALIZED,
  NUKE_INTERVAL_MS: DEFAULT_NUKE_INTERVAL_MS,
  CHANNEL_LABELS,
  SPECIAL_MEDIA_CHANNEL_ID: MEDIA_ARCHIVE_CHANNEL_ID,
  CHANNEL_NUKE_INTERVAL_MS,
  MEDIA_BACKUP_ENABLED,
  MEDIA_BACKUP_BUCKET,
  MEDIA_BACKUP_MAX_BYTES,
  BUNNY_STORAGE_ENDPOINT,
  BUNNY_STORAGE_ACCESS_KEY,
  BUNNY_CDN_BASE,
});

function formatRemainingMs(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function intervalMsForChannel(channelId) {
  const raw = parseInt(CHANNEL_NUKE_INTERVAL_MS[String(channelId)] || "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.max(60000, raw);
  return DEFAULT_NUKE_INTERVAL_MS;
}

async function sendArchiveTimer(message, channelArg) {
  const requested = String(channelArg || "").trim();
  const wantedIds = requested
    ? (/^\d{17,22}$/.test(requested) ? [requested] : [])
    : [...ARCHIVE_CHANNEL_IDS];
  if (requested && wantedIds.length === 0) {
    await message.reply("Use `!timer` / `6timer` or `!timer <channel_id>`.");
    return;
  }
  const rowsResp = await supabase
    .from("archive_nuke_schedule")
    .select("channel_id,next_nuke_at")
    .in("channel_id", wantedIds);
  if (rowsResp.error) {
    await message.reply(`Timer lookup failed: ${rowsResp.error.message}`);
    return;
  }
  const byId = new Map();
  for (const r of rowsResp.data || []) byId.set(String(r.channel_id), r);

  const now = Date.now();
  const lines = ["**Archive nuke timers**"];
  for (const cid of wantedIds) {
    const label = CHANNEL_LABELS[cid] || `#${cid.slice(-6)}`;
    const row = byId.get(cid);
    if (row?.next_nuke_at) {
      const ts = new Date(row.next_nuke_at).getTime();
      if (Number.isFinite(ts) && ts > 0) {
        lines.push(`- ${label} (<#${cid}>): ${formatRemainingMs(ts - now)} (at <t:${Math.floor(ts / 1000)}:F>)`);
        continue;
      }
    }
    const intervalMs = intervalMsForChannel(cid);
    lines.push(`- ${label} (<#${cid}>): schedule not created yet (interval ${Math.round(intervalMs / 60000)} min)`);
  }
  await message.reply(lines.join("\n").slice(0, 1950));
}

bot.once("ready", () => {
  console.log(`Bot online as ${bot.user.tag}`);
  void postVerificationEmbed();
  startOAuthRevocationAuditLoop();
});

bot.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const raw = message.content.trim();
  const lower = raw.toLowerCase();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();

  if (cmd === "!timer" || cmd === "6timer") {
    await sendArchiveTimer(message, parts[1] || "");
    return;
  }
  if (lower !== "!restore") return;

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
