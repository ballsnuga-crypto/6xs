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
        proxyUrl: a.proxyURL ?? a.proxyUrl,
        name: a.name || null,
        contentType: a.contentType || null,
        size: a.size ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        duration: a.duration ?? null,
        ephemeral: Boolean(a.ephemeral),
      }))
    : [];
  const embeds = message.embeds?.size
    ? [...message.embeds.values()].map((e) => e.toJSON())
    : [];
  const stickers =
    message.stickers?.size > 0
      ? [...message.stickers.values()].map((s) => ({
          id: String(s.id),
          name: s.name,
          url: s.url,
        }))
      : [];
  const author = message.author;
  const row = {
    channel_id: String(message.channelId),
    message_id: String(message.id),
    guild_id: String(message.guildId),
    author_id: String(author?.id || "0"),
    author_tag: author?.tag || author?.username || "unknown",
    author_username: author?.username || null,
    author_avatar_hash: author?.avatar || null,
    content: message.content || "",
    attachments,
    embeds,
    stickers,
    created_at_discord: message.createdAt?.toISOString() || new Date().toISOString(),
  };
  let { error } = await supabase.from("archive_messages").upsert(row, {
    onConflict: "channel_id,message_id",
  });
  if (error && String(error.message || "").includes("stickers")) {
    const rowNoStickers = { ...row };
    delete rowNoStickers.stickers;
    ({ error } = await supabase.from("archive_messages").upsert(rowNoStickers, {
      onConflict: "channel_id,message_id",
    }));
  }
  if (error && String(error.message || "").includes("author_avatar_hash")) {
    const rowMinimal = {
      channel_id: row.channel_id,
      message_id: row.message_id,
      guild_id: row.guild_id,
      author_id: row.author_id,
      author_tag: row.author_tag,
      content: row.content,
      attachments: row.attachments,
      embeds: row.embeds,
      created_at_discord: row.created_at_discord,
    };
    ({ error } = await supabase.from("archive_messages").upsert(rowMinimal, {
      onConflict: "channel_id,message_id",
    }));
  }
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

/**
 * True if the Discord user belongs to ARCHIVE_GUILD_ID.
 *
 * IMPORTANT: `@me/guilds` only returns ~200 guilds max; users in many servers may be false negatives.
 * We therefore prefer the authoritative check: REST **Get Guild Member** with the bot token.
 */
async function userMayViewArchive(accessToken, discordUserId, guildId, botToken) {
  const gid = String(guildId || "").trim();
  const uid = String(discordUserId || "").trim();
  if (!gid || !uid) return false;

  if (botToken) {
    try {
      const mr = await fetch(`${DISCORD_API}/guilds/${gid}/members/${uid}`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (mr.ok) return true;
      if (mr.status === 403) {
        console.warn(
          "[archive] GET /guilds/.../members/... returned 403 — enable **Server Members Intent** for your bot app if this persists."
        );
      }
    } catch (e) {
      console.warn("[archive] bot member lookup failed:", e.message);
    }
  }

  if (accessToken) {
    try {
      if (await userGuildsInclude(accessToken, gid)) return true;
    } catch {
      /* fall through */
    }
  }

  return false;
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
  } = deps;

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
    if (!u?.id) {
      await logAccess(supabase, req, null, req.path, "blocked_no_session");
      return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl || "/archive")}`);
    }
    const ok = await userMayViewArchive(u.accessToken, u.id, ARCHIVE_GUILD_ID, BOT_TOKEN);
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
      const inGuild = await userMayViewArchive(accessToken, me.id, ARCHIVE_GUILD_ID, BOT_TOKEN);
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

  const intervalMs = Math.max(60 * 60 * 1000, NUKE_INTERVAL_MS || 24 * 60 * 60 * 1000);
  const MIN_SCHEDULE_MS = 60 * 1000;

  /**
   * Reads/writes archive_nuke_schedule so restarts never purge immediately:
   * new channel → first fire in `intervalMs`; overdue → push next fire forward without purging on boot.
   */
  async function prepareDelayMs(channelId) {
    const { data, error } = await supabase
      .from("archive_nuke_schedule")
      .select("next_nuke_at")
      .eq("channel_id", channelId)
      .maybeSingle();

    if (error) {
      console.warn("[archive] schedule read failed (run supabase_archive.sql):", error.message);
      return intervalMs;
    }

    const now = Date.now();

    if (!data?.next_nuke_at) {
      const next = new Date(now + intervalMs);
      await supabase.from("archive_nuke_schedule").upsert(
        { channel_id: channelId, next_nuke_at: next.toISOString() },
        { onConflict: "channel_id" }
      );
      console.log(
        `[archive] ${channelId}: first scheduled nuke in ${intervalMs / 3600000}h (nothing runs on restart until then)`
      );
      return intervalMs;
    }

    const nextTs = new Date(data.next_nuke_at).getTime();
    let delay = nextTs - now;

    if (delay < MIN_SCHEDULE_MS) {
      const pushed = new Date(now + intervalMs);
      await supabase.from("archive_nuke_schedule").upsert(
        { channel_id: channelId, next_nuke_at: pushed.toISOString() },
        { onConflict: "channel_id" }
      );
      console.log(
        `[archive] ${channelId}: restart/overdue — skipped purge on boot; next wipe in ${intervalMs / 3600000}h`
      );
      delay = intervalMs;
    } else {
      console.log(
        `[archive] ${channelId}: next wipe in ${Math.round(delay / 60000)} min`
      );
    }

    return delay;
  }

  function startChannelScheduler(channelId) {
    async function loop() {
      let delayMs;
      try {
        delayMs = await prepareDelayMs(channelId);
      } catch (e) {
        console.error("[archive] prepareDelayMs", e);
        delayMs = intervalMs;
      }

      setTimeout(async () => {
        try {
          await postNukeEmbedAndOptionallyPurge(bot, channelId, SITE_BASE, true);
          const next = new Date(Date.now() + intervalMs);
          await supabase.from("archive_nuke_schedule").upsert(
            { channel_id: channelId, next_nuke_at: next.toISOString() },
            { onConflict: "channel_id" }
          );
          console.log(`[archive] nuke completed ${channelId}; next at ${next.toISOString()}`);
        } catch (e) {
          console.error(`[archive] nuke failed ${channelId}`, e);
        }
        loop();
      }, delayMs);
    }

    loop();
  }

  function scheduleNuksFromDb() {
    if (!ARCHIVE_GUILD_ID || ARCHIVE_CHANNEL_IDS.length === 0) {
      console.warn("[archive] scheduling skipped: set DISCORD_GUILD_ID and ARCHIVE_CHANNEL_IDS");
      return;
    }
    for (const cid of ARCHIVE_CHANNEL_IDS) {
      startChannelScheduler(cid);
    }
    console.log(
      `[archive] ${ARCHIVE_CHANNEL_IDS.length} channel(s); wipe interval ${intervalMs / 3600000}h (persisted in archive_nuke_schedule)`
    );
  }

  bot.once("ready", () => {
    scheduleNuksFromDb();
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
<style>body{font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:2rem;max-width:520px;margin:0 auto;line-height:1.5}</style>
</head><body>
<h1>Not in the server</h1>
<p>Archives only open for members of the 6xs Discord on <strong>the same account</strong> you authorized.</p>
<p style="color:#b5bac1;font-size:14px">Still seeing this while you’re in the server? Confirm <code>DISCORD_GUILD_ID</code> matches your server ID, and in the Discord Developer Portal enable <strong>Server Members Intent</strong> for this bot, then restart.</p>
<p><a href="${escapeHtml(siteBase)}/auth/logout">Log out</a> · <a href="${escapeHtml(siteBase)}/">Back home</a></p>
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
    .msg-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
    .msg-head img.av { width:40px; height:40px; border-radius:50%; object-fit:cover; background:#1e2128; flex-shrink:0; }
    .meta { font-size:12px; color:var(--muted); }
    .meta strong { color:var(--text); font-size:14px; }
    .content { white-space:pre-wrap; word-break:break-word; font-size:14px; margin-top:4px; }
    .att { margin-top:10px; }
    .att img, .att video { max-width:100%; border-radius:8px; vertical-align:middle; }
    .embeds-preview { margin-top:8px; font-size:12px; color:var(--muted); border-left:3px solid #5865f2; padding-left:10px; }
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
    function avatarUrl(row) {
      const id = String(row.author_id || "");
      const h = row.author_avatar_hash;
      if (h) return "https://cdn.discordapp.com/avatars/" + id + "/" + h + ".png?size=64";
      try {
        var bi = BigInt(id);
        var idx = Number((bi >> 22n) % 6n);
        return "https://cdn.discordapp.com/embed/avatars/" + idx + ".png";
      } catch (e) {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
      }
    }
    function renderAttachments(att) {
      if (!Array.isArray(att) || !att.length) return "";
      var html = "";
      for (var i = 0; i < att.length; i++) {
        var a = att[i];
        var url = a.proxyUrl || a.proxy_url || a.url || "";
        var ct = String(a.contentType || a.content_type || "").toLowerCase();
        var name = a.name || "attachment";
        if (!url) continue;
        if (ct.indexOf("image/") === 0) {
          html += '<div class="att"><img src="' + escapeHtml(url) + '" alt="" loading="lazy" /></div>';
        } else if (ct.indexOf("video/") === 0) {
          html += '<div class="att"><video controls preload="metadata" src="' + escapeHtml(url) + '"></video></div>';
        } else if (ct.indexOf("audio/") === 0 || name.indexOf("voice-message") !== -1) {
          html += '<div class="att"><audio controls src="' + escapeHtml(url) + '"></audio></div>';
        } else {
          html += '<div class="att"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(name) + "</a>";
          if (a.size) html += ' <span style="color:#9aa0a6;font-size:12px">(' + Math.round(a.size/1024) + " KB)</span>";
          html += "</div>";
        }
      }
      return html;
    }
    function renderStickers(st) {
      if (!Array.isArray(st) || !st.length) return "";
      var h = "";
      for (var i = 0; i < st.length; i++) {
        if (st[i].url) h += '<div class="att"><img src="' + escapeHtml(st[i].url) + '" alt="' + escapeHtml(st[i].name||"") + '" width="160" loading="lazy" /></div>';
      }
      return h;
    }
    function renderEmbeds(embeds) {
      if (!Array.isArray(embeds) || !embeds.length) return "";
      var parts = [];
      for (var i = 0; i < embeds.length; i++) {
        var e = embeds[i];
        var t = (e.title || "") + (e.description ? "\\n" + e.description : "");
        if (e.url) t += "\\n" + e.url;
        if (t.trim()) parts.push(t.trim());
      }
      if (!parts.length) return "";
      return '<div class="embeds-preview">' + escapeHtml(parts.join("\\n---\\n").slice(0, 1500)) + "</div>";
    }
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
        const disp = row.author_tag || row.author_username || row.author_id;
        div.innerHTML =
          '<div class="msg-head">' +
            '<img class="av" src="' + escapeHtml(avatarUrl(row)) + '" width="40" height="40" alt="" />' +
            '<div><div class="meta"><strong>' + escapeHtml(String(disp)) + "</strong> · " + escapeHtml(when) + "</div></div>" +
          "</div>" +
          '<div class="content">' + escapeHtml(row.content || "") + "</div>" +
          renderAttachments(row.attachments) +
          renderStickers(row.stickers) +
          renderEmbeds(row.embeds);
        feed.appendChild(div);
      }
    }
    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s == null ? "" : s;
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
