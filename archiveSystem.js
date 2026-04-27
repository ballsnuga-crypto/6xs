/**
 * 6xs.lol archive: message logging, 24h channel reset + embed, site auth, access logs.
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const DISCORD_API = "https://discord.com/api/v10";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function logAccess(supabase, req, discordUserId, path, note) {
  const xf = req.headers["x-forwarded-for"];
  const ip = (typeof xf === "string" ? xf.split(",")[0] : "")?.trim() || req.socket?.remoteAddress || "";
  const ua = String(req.headers["user-agent"] || "").slice(0, 2000);
  try {
    await supabase.from("archive_access_logs").insert({
      discord_user_id: discordUserId || null,
      ip: ip || null,
      user_agent: ua || null,
      path: String(path || "").slice(0, 500),
      note: note ? String(note).slice(0, 500) : null,
    });
  } catch (e) {
    console.warn("[archive] access log insert failed:", e.message);
  }
}

async function insertArchiveMessage(supabase, message) {
  const attachments = message.attachments?.size
    ? [...message.attachments.values()].map((a) => ({
        url: a.url,
        name: a.name,
        contentType: a.contentType,
      }))
    : [];
  const embeds = message.embeds?.size
    ? [...message.embeds.values()].map((e) => e.toJSON())
    : [];
  const row = {
    channel_id: String(message.channelId),
    message_id: String(message.id),
    guild_id: String(message.guildId),
    author_id: String(message.author?.id || "0"),
    author_tag: message.author?.tag || message.author?.username || "unknown",
    content: message.content || "",
    attachments,
    embeds,
    created_at_discord: message.createdAt?.toISOString() || new Date().toISOString(),
  };
  const { error } = await supabase.from("archive_messages").upsert(row, {
    onConflict: "channel_id,message_id",
  });
  if (error) console.warn("[archive] log message failed:", error.message);
}

/** Purge channel: bulk-delete when &lt;14d; older messages one-by-one. */
async function purgeChannelMessages(channel) {
  let safety = 0;
  while (safety++ < 5000) {
    const batch = await channel.messages.fetch({ limit: 100 });
    if (batch.size === 0) break;
    const twoWeeks = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = batch.filter((m) => m.createdTimestamp > twoWeeks);
    const old = batch.filter((m) => m.createdTimestamp <= twoWeeks);
    try {
      if (recent.size > 1) {
        await channel.bulkDelete(recent, true);
      } else if (recent.size === 1) {
        await recent.first().delete().catch(() => {});
      }
    } catch (e) {
      for (const m of recent.values()) await m.delete().catch(() => {});
    }
    for (const m of old.values()) {
      await m.delete().catch(() => {});
      await sleep(350);
    }
    if (batch.size < 100) break;
  }
}

function buildNukeEmbed(siteBase) {
  const url = `${siteBase.replace(/\/$/, "")}/archive`;
  return new EmbedBuilder()
    .setTitle("24-hour channel rotation")
    .setColor(0x3ba55d)
    .setDescription(
      "**This channel clears on a 24-hour timer.** Messages here are wiped on schedule — your words aren’t lost: " +
        "members can read the full archive anytime on **6xs.lol**.\n\n" +
        "**Next wipe in ~24 hours.** Grab what you need in-chat, or open the archive below whenever you want."
    )
    .addFields({
      name: "Read the archive",
      value: `[**Open 6xs archives →**](${url})`,
      inline: false,
    })
    .setFooter({ text: "6xs · member-only archive · stay in the server to access" })
    .setTimestamp();
}

async function postNukeEmbedAndOptionallyPurge(bot, channelId, siteBase, doPurge) {
  const ch = await bot.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.warn(`[archive] cannot fetch channel ${channelId}`);
    return;
  }
  if (doPurge) await purgeChannelMessages(ch);
  const embed = buildNukeEmbed(siteBase);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("View archives on 6xs.lol").setStyle(ButtonStyle.Link).setURL(`${siteBase.replace(/\/$/, "")}/archive`)
  );
  await ch.send({ embeds: [embed], components: [row] });
}

async function userGuildsInclude(accessToken, guildId) {
  const r = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return false;
  const guilds = await r.json();
  if (!Array.isArray(guilds)) return false;
  return guilds.some((g) => String(g.id) === String(guildId));
}

async function exchangeSiteCode(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const tokenResp = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    throw new Error(`token ${tokenResp.status} ${t}`);
  }
  return tokenResp.json();
}

async function fetchDiscordMe(accessToken) {
  const meResp = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meResp.ok) throw new Error("profile fetch failed");
  return meResp.json();
}

function attachArchiveSystem(deps) {
  const {
    app,
    bot,
    supabase,
    SITE_BASE,
    ARCHIVE_GUILD_ID,
    ARCHIVE_CHANNEL_IDS,
    CLIENT_ID,
    CLIENT_SECRET,
    BOT_TOKEN,
    SITE_AUTH_REDIRECT_URI,
    NUKE_INTERVAL_MS,
    CHANNEL_LABELS,
    FIRST_NUKE_DELAY_MS,
  } = deps;

  const firstDelayMs =
    FIRST_NUKE_DELAY_MS != null && FIRST_NUKE_DELAY_MS !== ""
      ? Math.max(0, Number(FIRST_NUKE_DELAY_MS))
      : 60 * 1000;

  const authRedirect = SITE_AUTH_REDIRECT_URI;

  function buildSiteLoginUrl() {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: authRedirect,
      scope: "identify guilds",
      prompt: "consent",
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  }

  async function requireArchiveMember(req, res, next) {
    const u = req.session?.archiveUser;
    if (!u?.accessToken || !u?.id) {
      await logAccess(supabase, req, null, req.path, "blocked_no_session");
      return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl || "/archive")}`);
    }
    const ok = await userGuildsInclude(u.accessToken, ARCHIVE_GUILD_ID);
    if (!ok) {
      await logAccess(supabase, req, u.id, req.path, "blocked_not_in_guild");
      return res.status(403).type("html").send(pageNotInGuild(SITE_BASE));
    }
    await logAccess(supabase, req, u.id, req.path, "ok");
    next();
  }

  app.get("/", (req, res) => {
    logAccess(supabase, req, req.session?.archiveUser?.id || null, "/", "landing");
    res.type("html").send(landingHtml(SITE_BASE, Boolean(req.session?.archiveUser?.id)));
  });

  app.get("/auth/login", (req, res) => {
    const next = String(req.query.next || "/archive").slice(0, 200);
    req.session.oauthNext = next.startsWith("/") ? next : "/archive";
    res.redirect(302, buildSiteLoginUrl());
  });

  app.get("/auth/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");
    try {
      const tokens = await exchangeSiteCode(code, CLIENT_ID, CLIENT_SECRET, authRedirect);
      const accessToken = tokens.access_token;
      const me = await fetchDiscordMe(accessToken);
      const inGuild = await userGuildsInclude(accessToken, ARCHIVE_GUILD_ID);
      req.session.archiveUser = {
        id: me.id,
        username: me.username,
        global_name: me.global_name,
        avatar: me.avatar,
        accessToken,
      };
      await logAccess(supabase, req, me.id, "/auth/callback", inGuild ? "login_ok" : "login_not_in_guild");
      if (!inGuild) {
        return res.status(403).type("html").send(pageNotInGuild(SITE_BASE));
      }
      const next = req.session.oauthNext || "/archive";
      delete req.session.oauthNext;
      res.redirect(302, next);
    } catch (e) {
      console.error("[auth/callback]", e);
      res.status(500).send("Login failed");
    }
  });

  app.get("/auth/logout", (req, res) => {
    delete req.session.archiveUser;
    res.redirect(302, "/");
  });

  app.get("/archive", requireArchiveMember, async (req, res) => {
    const u = req.session.archiveUser;
    const labels = CHANNEL_LABELS || {};
    res.type("html").send(archiveShellHtml(SITE_BASE, u, ARCHIVE_CHANNEL_IDS, labels));
  });

  app.get("/api/archive/:channelId", requireArchiveMember, async (req, res) => {
    const channelId = String(req.params.channelId || "");
    if (!ARCHIVE_CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "unknown channel" });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10) || 0);
    const { data, error, count } = await supabase
      .from("archive_messages")
      .select("*", { count: "exact" })
      .eq("channel_id", channelId)
      .order("created_at_discord", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rows: data || [], total: count ?? null });
  });

  bot.on("messageCreate", async (message) => {
    if (!message.guild || message.author?.bot) return;
    if (!ARCHIVE_CHANNEL_IDS.includes(String(message.channelId))) return;
    await insertArchiveMessage(supabase, message);
  });

  const interval = NUKE_INTERVAL_MS || 24 * 60 * 60 * 1000;

  function scheduleNuke() {
    if (!ARCHIVE_GUILD_ID || ARCHIVE_CHANNEL_IDS.length === 0) {
      console.warn("[archive] NUKE skipped: set DISCORD_GUILD_ID and ARCHIVE_CHANNEL_IDS");
      return;
    }
    const run = async () => {
      for (const cid of ARCHIVE_CHANNEL_IDS) {
        try {
          await postNukeEmbedAndOptionallyPurge(bot, cid, SITE_BASE, true);
          console.log(`[archive] nuke cycle done for channel ${cid}`);
        } catch (e) {
          console.error(`[archive] nuke failed ${cid}`, e);
        }
      }
    };

    console.log(
      `[archive] ${ARCHIVE_CHANNEL_IDS.length} channel(s): first nuke in ${firstDelayMs / 1000}s, then every ${interval / 3600000}h`
    );
    setTimeout(() => {
      run();
      setInterval(run, interval);
    }, firstDelayMs);
  }

  bot.once("ready", () => {
    scheduleNuke();
  });

  return { buildSiteLoginUrl, logAccess };
}

function landingHtml(siteBase, loggedIn) {
  const login = `${siteBase.replace(/\/$/, "")}/auth/login`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>6xs.lol — archive</title>
  <style>
    :root { --bg:#0c0d10; --card:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --green:#3ba55d; --accent:#5865f2; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family:system-ui,sans-serif; background:var(--bg); color:var(--text);
      display:flex; align-items:center; justify-content:center; padding:24px;
      background-image: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59,165,93,0.15), transparent); }
    .card { max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:32px; text-align:center; }
    h1 { margin:0 0 8px; font-size:1.5rem; }
    p { color:var(--muted); line-height:1.55; margin:0 0 20px; }
    .btn { display:inline-block; padding:12px 22px; border-radius:10px; font-weight:600; text-decoration:none; background:var(--accent); color:#fff; }
    .btn:hover { filter:brightness(1.08); }
    .btn-green { background:var(--green); margin-top:8px; }
    .fine { font-size:12px; color:var(--muted); margin-top:20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>6xs archives</h1>
    <p>Read-only mirrors of rotating Discord channels. You must be a member of the 6xs server and sign in with Discord.</p>
    ${loggedIn
      ? `<a class="btn btn-green" href="${escapeHtml(siteBase)}/archive">Open archives</a>
         <p class="fine"><a href="${escapeHtml(siteBase)}/auth/logout" style="color:var(--muted)">Log out</a></p>`
      : `<a class="btn" href="${escapeHtml(login)}">Log in with Discord</a>
         <p class="fine">We only check membership — no posting from the web.</p>`}
  </div>
</body>
</html>`;
}

function pageNotInGuild(siteBase) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Access denied</title>
<style>body{font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:2rem;max-width:480px;margin:0 auto}</style>
</head><body>
<h1>Not in the server</h1>
<p>Archives are only for members of the 6xs Discord. Join the server, then try logging in again.</p>
<p><a href="${escapeHtml(siteBase)}/" style="color:#5865f2">Back home</a></p>
</body></html>`;
}

function archiveShellHtml(siteBase, user, channelIds, labels) {
  const channelsJson = JSON.stringify(channelIds);
  const labelsJson = JSON.stringify(labels);
  const name = escapeHtml(user.global_name || user.username || "member");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Archives — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --panel:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --green:#3ba55d; }
    body { margin:0; font-family:system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    header a { color:#5865f2; }
    .tabs { display:flex; gap:8px; padding:12px 20px; flex-wrap:wrap; border-bottom:1px solid var(--border); }
    .tabs button { background:#1e2128; border:1px solid var(--border); color:var(--text); padding:8px 14px; border-radius:8px; cursor:pointer; }
    .tabs button.active { border-color:var(--green); color:var(--green); }
    #feed { padding:20px; max-width:900px; margin:0 auto; }
    .msg { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
    .meta { font-size:12px; color:var(--muted); margin-bottom:6px; }
    .content { white-space:pre-wrap; word-break:break-word; font-size:14px; }
    .loading { color:var(--muted); padding:20px; }
  </style>
</head>
<body>
  <header>
    <span>Signed in as <strong>${name}</strong></span>
    <span><a href="/">Home</a> · <a href="/auth/logout">Log out</a></span>
  </header>
  <div class="tabs" id="tabs"></div>
  <div id="feed"><p class="loading">Loading…</p></div>
  <script>
    const CHANNEL_IDS = ${channelsJson};
    const LABELS = ${labelsJson};
    let active = CHANNEL_IDS[0] || "";
    const tabs = document.getElementById("tabs");
    const feed = document.getElementById("feed");
    CHANNEL_IDS.forEach((id) => {
      const b = document.createElement("button");
      b.textContent = LABELS[id] || ("#" + id.slice(-6));
      b.dataset.id = id;
      if (id === active) b.classList.add("active");
      b.onclick = () => { active = id; [...tabs.querySelectorAll("button")].forEach(x => x.classList.toggle("active", x.dataset.id === active)); load(); };
      tabs.appendChild(b);
    });
    async function load() {
      feed.innerHTML = '<p class="loading">Loading…</p>';
      const r = await fetch("/api/archive/" + active + "?limit=80");
      if (!r.ok) { feed.textContent = "Failed to load."; return; }
      const j = await r.json();
      feed.innerHTML = "";
      if (!j.rows || !j.rows.length) {
        feed.innerHTML = '<p class="loading">No messages logged yet.</p>';
        return;
      }
      for (const row of j.rows) {
        const div = document.createElement("div");
        div.className = "msg";
        const when = row.created_at_discord ? new Date(row.created_at_discord).toLocaleString() : "";
        div.innerHTML = '<div class="meta">' + escapeHtml(row.author_tag || row.author_id) + " · " + escapeHtml(when) + '</div>' +
          '<div class="content">' + escapeHtml(row.content || "") + '</div>';
        feed.appendChild(div);
      }
    }
    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }
    load();
  </script>
</body>
</html>`;
}

module.exports = {
  attachArchiveSystem,
  logAccess,
  escapeHtml,
};
