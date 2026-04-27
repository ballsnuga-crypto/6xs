require("dotenv").config();

const express = require("express");
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
} = process.env;

const VERIFY_CHANNEL_ID = "1498120494140887080";
const SITE_BASE = (PUBLIC_SITE_URL || "https://6xs.lol").replace(/\/$/, "");

if (
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !BOT_TOKEN ||
  !REDIRECT_URI ||
  !SUPABASE_URL ||
  !SUPABASE_KEY ||
  !OAUTH2_LINK
) {
  throw new Error("Missing required environment variables. Check your .env file.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      <a class="btn btn-primary" href="${escapeHtml(SITE_BASE)}/">Open ${escapeHtml(new URL(SITE_BASE).hostname || "6xs.lol")}</a>
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
      redirect_uri: REDIRECT_URI,
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
    console.error("[OAuth callback error]", err);
    return res.status(500).type("html").send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0c0d10;color:#e8eaed;"><h1>Something went wrong</h1><p>OAuth flow failed. Try again from the server.</p></body></html>`
    );
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
      new ButtonBuilder().setLabel("Verify Now").setStyle(ButtonStyle.Link).setURL(OAUTH2_LINK)
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

  const { data, error } = await supabase.from("discord_backups").select("user_id, access_token");
  if (error) {
    await message.channel.send(`Restore failed while reading backups: ${error.message}`);
    return;
  }

  let restoredCount = 0;
  for (const row of data || []) {
    try {
      const resp = await fetch(
        `https://discord.com/api/guilds/${message.guild.id}/members/${row.user_id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ access_token: row.access_token }),
        }
      );

      if (resp.ok || resp.status === 201 || resp.status === 204) {
        restoredCount += 1;
      } else {
        const body = await resp.text();
        console.error(`[Restore] Failed for user ${row.user_id}: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[Restore] Error for user ${row.user_id}:`, err);
    }

    await sleep(2000);
  }

  await message.channel.send(`Restore finished. Total members restored: ${restoredCount}`);
});

bot.login(BOT_TOKEN);
app.listen(Number(PORT) || 50004, () => {
  console.log(`OAuth server listening on port ${Number(PORT) || 50004}`);
});
