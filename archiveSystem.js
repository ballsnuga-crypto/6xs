/**
 * 6xs.lol archive: message logging, 24h channel reset + embed, site auth, access logs.
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const fs = require("fs/promises");
const path = require("path");

const DISCORD_API = "https://discord.com/api/v10";
let mediaBucketEnsurePromise = null;
let economySupabase = null;
const ECONOMY_FILE = process.env.ECONOMY_FILE_PATH
  ? path.resolve(String(process.env.ECONOMY_FILE_PATH))
  : path.resolve(__dirname, "..", "economy_data.json");
const START_WALLET = 500;
let economyLock = Promise.resolve();

/** PostgREST `.eq()` for int8 Discord snowflakes — never `Number()` (MAX_SAFE_INTEGER is 2^53-1). */
function econBigInt(v) {
  return String(v);
}

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

function extractMentionUserIds(message) {
  const ids = new Set();
  try {
    message.mentions?.users?.forEach?.((u) => ids.add(String(u.id)));
  } catch {
    /* ignore */
  }
  const raw = message.content || "";
  const re = /<@!?(\d{10,22})>/g;
  let m;
  while ((m = re.exec(raw))) {
    ids.add(m[1]);
  }
  return [...ids];
}

function attachmentLooksMedia(a) {
  const ct = String(a?.contentType || a?.content_type || "").toLowerCase();
  const name = String(a?.name || "").toLowerCase();
  if (ct.startsWith("image/") || ct.startsWith("video/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mkv|avi)$/i.test(name);
}

function rowHasMedia(row) {
  const attachments = Array.isArray(row?.attachments) ? row.attachments : [];
  for (const a of attachments) {
    if (attachmentLooksMedia(a)) return true;
  }
  return false;
}

/** Stickers, image/video attachments, or embeds with image/video/thumbnail (same rules as archive “media”). */
function discordMessageHasArchivableMedia(message) {
  try {
    if (message.stickers?.size) return true;
    if (message.attachments?.size) {
      for (const a of message.attachments.values()) {
        if (attachmentLooksMedia(a)) return true;
      }
    }
    if (message.embeds?.size) {
      for (const e of message.embeds.values()) {
        if (e.image?.url || e.thumbnail?.url || e.video?.url) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** #tcc / #blood — media-only archive + post permalink + `6vid`. */
const ARCHIVE_POSTLINK_6VID_CHANNEL_IDS = new Set(["1498278738096295936", "1498521334198702223"]);

function archiveAttachmentIsVideo(a) {
  const ct = String(a?.contentType || a?.content_type || "").toLowerCase();
  const name = String(a?.name || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(name);
}

/** Prefer mirrored CDN URL after normalizeArchiveMessageRow. */
function archiveVideoUrlFromAttachment(a) {
  const url = String(a?.mirroredUrl || a?.mirrored_url || a?.proxyUrl || a?.proxy_url || a?.url || "").trim();
  if (!/^https:\/\//i.test(url)) return null;
  return url;
}

/**
 * Scan recent archive rows for video attachments; returns { url, messageId } or null.
 * Rewrites Supabase → site CDN via normalizeArchiveMessageRow.
 */
async function pickRandomArchivedVideoFromChannel(supabase, channelId, cdnBase, bucket, maxRows = 4000) {
  const page = 200;
  const pool = [];
  for (let offset = 0; offset < maxRows; offset += page) {
    const { data, error } = await supabase
      .from("archive_messages")
      .select("attachments,message_id")
      .eq("channel_id", String(channelId))
      .order("created_at_discord", { ascending: false })
      .range(offset, offset + page - 1);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;
    for (const row of rows) {
      const norm = normalizeArchiveMessageRow(row, cdnBase, bucket);
      const ats = Array.isArray(norm.attachments) ? norm.attachments : [];
      for (const a of ats) {
        if (!archiveAttachmentIsVideo(a)) continue;
        const u = archiveVideoUrlFromAttachment(a);
        if (u) pool.push({ url: u, messageId: String(row.message_id || "") });
      }
    }
    if (rows.length < page) break;
  }
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function replyArchive6vidCommand(message, supabase, cdnBase, bucket, siteBase, channelId) {
  const pick = await pickRandomArchivedVideoFromChannel(supabase, channelId, cdnBase, bucket);
  const base = String(siteBase || "").replace(/\/$/, "");
  if (!pick?.url || !pick.messageId) {
    await message.reply({
      content:
        "No archived **videos** in this channel yet (or they were logged before media mirroring). Try again after more video posts are archived.",
    });
    return;
  }
  const postUrl = `${base}/archive/post/${encodeURIComponent(String(channelId))}/${encodeURIComponent(pick.messageId)}`;
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("Random archived video")
    .setDescription(
      `**CDN (6xs):** [open clip](${pick.url})\n**Archive post:** [open page](${postUrl})`,
    );
  await message.reply({ embeds: [embed] });
}

function safeStorageName(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function joinBaseAndPath(base, path) {
  const cleanBase = String(base || "").replace(/\/+$/, "");
  const parts = String(path || "")
    .split("/")
    .filter(Boolean)
    .map((p) => encodeURIComponent(p));
  return `${cleanBase}/${parts.join("/")}`;
}

function guessBunnyCdnBaseFromEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint || ""));
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    const zone = parts[0];
    if (!zone) return "";
    return `https://${zone}.b-cdn.net`;
  } catch {
    return "";
  }
}

function normalizeBunnyCdnBase(input, fallbackEndpoint) {
  const raw = String(input || "").trim();
  if (!raw) return guessBunnyCdnBaseFromEndpoint(fallbackEndpoint);
  try {
    const u = new URL(raw);
    if (/^storage\.bunnycdn\.com$/i.test(u.hostname)) {
      const guessed = guessBunnyCdnBaseFromEndpoint(raw);
      if (guessed) return guessed;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return guessBunnyCdnBaseFromEndpoint(fallbackEndpoint);
  }
}

function rewriteSupabasePublicToCdn(url, cdnBase, bucket) {
  const u = String(url || "").trim();
  const base = String(cdnBase || "").trim().replace(/\/+$/, "");
  const b = String(bucket || "archive-media").trim();
  if (!u || !base) return u;
  const marker = `/storage/v1/object/public/${b}/`;
  const idx = u.indexOf(marker);
  if (idx === -1) return u;
  const rel = u.slice(idx + marker.length);
  return joinBaseAndPath(base, rel);
}

function applyMediaCdnToRow(row, cdnBase, bucket) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  if (Array.isArray(out.attachments)) {
    out.attachments = out.attachments.map((a) => {
      const x = { ...(a || {}) };
      if (x.mirroredUrl) {
        x.mirroredUrl = rewriteSupabasePublicToCdn(x.mirroredUrl, cdnBase, bucket);
      }
      if (x.mirrored_url) {
        x.mirrored_url = rewriteSupabasePublicToCdn(x.mirrored_url, cdnBase, bucket);
      }
      return x;
    });
  }
  return out;
}

/** Supabase/PostgREST may return jsonb `author_roles` as a JSON string — normalize for the web UI. */
function parseAuthorRolesJsonb(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "null") return [];
    try {
      const p = JSON.parse(s);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeArchiveMessageRow(row, cdnBase, bucket) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row, author_roles: parseAuthorRolesJsonb(row.author_roles) };
  return applyMediaCdnToRow(out, cdnBase, bucket);
}

function withEconomyLock(fn) {
  const run = economyLock.then(fn, fn);
  economyLock = run.catch(() => {});
  return run;
}

async function readEconomyData() {
  try {
    const raw = await fs.readFile(ECONOMY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveEconomyData(data) {
  const tmp = `${ECONOMY_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, ECONOMY_FILE);
}

function economyKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function resolveEconomyKey(data, guildId, userId) {
  const preferred = economyKey(guildId, userId);
  if (data && Object.prototype.hasOwnProperty.call(data, preferred)) return preferred;
  const suffix = `:${userId}`;
  const keys = Object.keys(data || {}).filter((k) => k.endsWith(suffix));
  if (keys.length === 1) return keys[0];
  return preferred;
}

function getWalletFromEntry(entry) {
  return Math.max(0, parseInt(entry?.wallet || START_WALLET, 10) || START_WALLET);
}

async function adjustWallet(guildId, userId, delta) {
  if (economySupabase) {
    const viaSupabase = await withEconomyLock(async () => {
      try {
        let { data, error } = await economySupabase
          .from("economy_wallets")
          .select("guild_id,user_id,wallet")
          .eq("guild_id", econBigInt(guildId))
          .eq("user_id", econBigInt(userId))
          .maybeSingle();
        if (error) return null;
        if (!data) {
          const fb = await economySupabase
            .from("economy_wallets")
            .select("guild_id,user_id,wallet,updated_at")
            .eq("user_id", econBigInt(userId))
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (fb.error || !fb.data) return null;
          data = fb.data;
        }
        const next = Math.max(0, (parseInt(data.wallet || "0", 10) || 0) + delta);
        const { error: upErr } = await economySupabase
          .from("economy_wallets")
          .update({ wallet: next })
          .eq("guild_id", econBigInt(data.guild_id))
          .eq("user_id", econBigInt(data.user_id));
        if (upErr) return null;
        return next;
      } catch {
        return null;
      }
    });
    if (viaSupabase != null) return viaSupabase;
  }
  return withEconomyLock(async () => {
    const all = await readEconomyData();
    const key = resolveEconomyKey(all, guildId, userId);
    const hasExisting = all[key] && typeof all[key] === "object";
    if (!hasExisting) {
      // Do not create a fresh 500-wallet from web side; force using server-created profile.
      return null;
    }
    const cur = all[key];
    const next = Math.max(0, getWalletFromEntry(cur) + delta);
    all[key] = { ...cur, wallet: next };
    await saveEconomyData(all);
    return next;
  });
}

async function readWallet(guildId, userId) {
  if (economySupabase) {
    try {
      let { data, error } = await economySupabase
        .from("economy_wallets")
        .select("wallet")
        .eq("guild_id", econBigInt(guildId))
        .eq("user_id", econBigInt(userId))
        .maybeSingle();
      if (error) data = null;
      if (!data) {
        const fb = await economySupabase
          .from("economy_wallets")
          .select("wallet,updated_at")
          .eq("user_id", econBigInt(userId))
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!fb.error && fb.data) data = fb.data;
      }
      if (data) return Math.max(0, parseInt(data.wallet || "0", 10) || 0);
    } catch {
      // fall through to file fallback
    }
  }
  const all = await readEconomyData();
  const key = resolveEconomyKey(all, guildId, userId);
  if (!(all[key] && typeof all[key] === "object")) return null;
  const cur = all[key];
  return getWalletFromEntry(cur);
}

async function mirrorAttachmentToBunny(attachment, ctx, cfg) {
  if (!cfg?.bunnyEndpoint || !cfg?.bunnyAccessKey) return null;
  if (!attachmentLooksMedia(attachment)) return null;
  const rawUrl = attachment?.url || attachment?.proxyUrl || attachment?.proxy_url;
  if (!rawUrl) return null;
  const size = Number(attachment?.size || 0);
  if (size > 0 && size > cfg.maxBytes) return null;

  const name = safeStorageName(attachment?.name || `media-${ctx.index}`);
  const path = `${ctx.guildId}/${ctx.channelId}/${ctx.messageId}/${ctx.index}-${name}`;

  try {
    const fr = await fetch(rawUrl);
    if (!fr.ok) return null;
    const ab = await fr.arrayBuffer();
    if (cfg.maxBytes > 0 && ab.byteLength > cfg.maxBytes) return null;
    const payload = Buffer.from(ab);
    const uploadUrl = joinBaseAndPath(cfg.bunnyEndpoint, path);
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        AccessKey: cfg.bunnyAccessKey,
        "Content-Type": attachment?.contentType || "application/octet-stream",
      },
      body: payload,
    });
    if (!putResp.ok) {
      const t = await putResp.text().catch(() => "");
      console.warn(`[archive] bunny upload failed ${putResp.status}: ${String(t).slice(0, 180)}`);
      return null;
    }
    const readBase = cfg.bunnyCdnBase || guessBunnyCdnBaseFromEndpoint(cfg.bunnyEndpoint) || cfg.bunnyEndpoint;
    return joinBaseAndPath(readBase, path);
  } catch (e) {
    console.warn("[archive] bunny mirror fetch/upload error:", e.message);
    return null;
  }
}

async function ensureMediaBucket(supabase, bucketName) {
  if (mediaBucketEnsurePromise) return mediaBucketEnsurePromise;
  mediaBucketEnsurePromise = (async () => {
    try {
      const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
      if (listErr) {
        console.warn("[archive] storage listBuckets failed:", listErr.message);
        return;
      }
      const exists = (buckets || []).some((b) => String(b.name || b.id) === bucketName);
      if (exists) return;
      const { error: createErr } = await supabase.storage.createBucket(bucketName, {
        public: true,
      });
      if (createErr) {
        console.warn("[archive] storage createBucket failed:", createErr.message);
      } else {
        console.log(`[archive] created storage bucket '${bucketName}' (public)`);
      }
    } catch (e) {
      console.warn("[archive] storage bucket ensure failed:", e.message);
    }
  })();
  return mediaBucketEnsurePromise;
}

async function mirrorAttachmentToStorage(supabase, attachment, ctx, cfg) {
  if (!cfg?.enabled) return null;
  if (cfg?.provider === "bunny") {
    return mirrorAttachmentToBunny(attachment, ctx, cfg);
  }
  if (!attachmentLooksMedia(attachment)) return null;
  const rawUrl = attachment?.url || attachment?.proxyUrl || attachment?.proxy_url;
  if (!rawUrl) return null;
  const size = Number(attachment?.size || 0);
  if (size > 0 && size > cfg.maxBytes) return null;

  const name = safeStorageName(attachment?.name || `media-${ctx.index}`);
  const path = `${ctx.guildId}/${ctx.channelId}/${ctx.messageId}/${ctx.index}-${name}`;
  await ensureMediaBucket(supabase, cfg.bucket);

  try {
    const fr = await fetch(rawUrl);
    if (!fr.ok) return null;
    const ab = await fr.arrayBuffer();
    if (cfg.maxBytes > 0 && ab.byteLength > cfg.maxBytes) return null;
    const payload = Buffer.from(ab);
    const { error } = await supabase.storage.from(cfg.bucket).upload(path, payload, {
      contentType: attachment?.contentType || "application/octet-stream",
      upsert: false,
      cacheControl: "31536000",
    });
    if (error && !/already exists|duplicate/i.test(String(error.message || ""))) {
      console.warn("[archive] media mirror upload failed:", error.message);
      return null;
    }
    const pub = supabase.storage.from(cfg.bucket).getPublicUrl(path);
    return pub?.data?.publicUrl || null;
  } catch (e) {
    console.warn("[archive] media mirror fetch/upload error:", e.message);
    return null;
  }
}

function buildAuthorRolesSnapshot(member, guildSnowflakeId) {
  if (!member?.roles?.cache || !guildSnowflakeId) return [];
  try {
    return [...member.roles.cache.values()]
      .filter((r) => String(r.id) !== String(guildSnowflakeId))
      .sort((a, b) => (b.position || 0) - (a.position || 0))
      .slice(0, 16)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name || "").slice(0, 80),
        position: typeof r.position === "number" && Number.isFinite(r.position) ? r.position : 0,
        color: typeof r.color === "number" ? r.color : 0,
        hexColor:
          typeof r.hexColor === "string" && r.hexColor !== "#000000"
            ? r.hexColor
            : null,
      }));
  } catch {
    return [];
  }
}

/** Fetches missing Role objects into guild cache so member.roles.cache is complete (common on messageCreate). */
async function resolveAuthorRolesForInsert(member, guild) {
  if (!member || !guild) return [];
  let snap = buildAuthorRolesSnapshot(member, guild.id);
  if (snap.length > 0) return snap;
  const ids = Array.isArray(member._roles) ? member._roles.map(String) : [];
  const want = ids.filter((id) => id && id !== String(guild.id));
  if (want.length === 0) return [];
  for (const rid of want.slice(0, 24)) {
    if (!guild.roles.cache.has(rid)) {
      try {
        await guild.roles.fetch(rid);
      } catch {
        /* role deleted or no access */
      }
    }
  }
  snap = buildAuthorRolesSnapshot(member, guild.id);
  if (snap.length > 0) return snap;
  try {
    await guild.roles.fetch();
  } catch {
    /* ignore */
  }
  return buildAuthorRolesSnapshot(member, guild.id);
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

function replyPreviewFromMessage(refMsg) {
  const c = refMsg.content || "";
  if (c.length > 200) return `${c.slice(0, 200)}…`;
  if (c) return c;
  if (refMsg.attachments?.size) return "[attachment]";
  if (refMsg.embeds?.size) return "[embed]";
  if (refMsg.stickers?.size) return "[sticker]";
  return "";
}

async function insertArchiveMessage(supabase, message, mediaCfg = null) {
  /** Always prefer a REST refresh: cached members skip the API without `force`, so `_roles` can stay stale on messageCreate. */
  let member = null;
  if (message.guild && message.author?.id) {
    try {
      member = await message.guild.members.fetch({ user: message.author.id, force: true });
    } catch {
      member = message.member;
      if (!member) {
        try {
          member = await message.guild.members.fetch({ user: message.author.id });
        } catch {
          member = null;
        }
      }
    }
  }

  let reply_to_message_id = null;
  let reply_to_author_id = null;
  let reply_to_author_tag = null;
  let reply_to_content = null;
  if (message.reference?.messageId) {
    reply_to_message_id = String(message.reference.messageId);
    try {
      const refMsg = await message.fetchReference();
      if (refMsg) {
        reply_to_author_id = String(refMsg.author?.id || "");
        reply_to_author_tag = refMsg.author?.tag || refMsg.author?.username || null;
        reply_to_content = replyPreviewFromMessage(refMsg) || null;
      }
    } catch {
      /* deleted, inaccessible, or cross-context */
    }
  }

  const mentionUserIds = extractMentionUserIds(message);
  const authorRoles = await resolveAuthorRolesForInsert(member, message.guild);

  const attachments = [];
  if (message.attachments?.size) {
    const list = [...message.attachments.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const mirroredUrl = await mirrorAttachmentToStorage(
        supabase,
        {
          url: a.url,
          proxyUrl: a.proxyURL ?? a.proxyUrl,
          name: a.name || null,
          contentType: a.contentType || null,
          size: a.size ?? null,
        },
        {
          guildId: String(message.guildId || "0"),
          channelId: String(message.channelId || "0"),
          messageId: String(message.id || "0"),
          index: i,
        },
        mediaCfg
      );
      attachments.push({
        url: a.url,
        proxyUrl: a.proxyURL ?? a.proxyUrl,
        mirroredUrl: mirroredUrl || null,
        name: a.name || null,
        contentType: a.contentType || null,
        size: a.size ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        duration: a.duration ?? null,
        ephemeral: Boolean(a.ephemeral),
      });
    }
  }
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
  const authorDisplayName =
    member?.displayName || author?.globalName || author?.username || null;
  let working = {
    channel_id: String(message.channelId),
    message_id: String(message.id),
    guild_id: String(message.guildId),
    author_id: String(author?.id || "0"),
    author_tag: author?.tag || author?.username || "unknown",
    author_username: author?.username || null,
    author_display_name: authorDisplayName,
    author_is_bot: Boolean(author?.bot),
    author_avatar_hash: author?.avatar || null,
    content: message.content || "",
    attachments,
    embeds,
    stickers,
    author_roles: authorRoles,
    mention_user_ids: mentionUserIds,
    reply_to_message_id,
    reply_to_author_id,
    reply_to_author_tag,
    reply_to_content,
    created_at_discord: message.createdAt?.toISOString() || new Date().toISOString(),
  };
  let { error } = await supabase.from("archive_messages").upsert(working, {
    onConflict: "channel_id,message_id",
  });
  if (error && String(error.message || "").includes("stickers")) {
    delete working.stickers;
    ({ error } = await supabase.from("archive_messages").upsert(working, {
      onConflict: "channel_id,message_id",
    }));
  }
  if (error && String(error.message || "").includes("author_avatar_hash")) {
    delete working.author_avatar_hash;
    ({ error } = await supabase.from("archive_messages").upsert(working, {
      onConflict: "channel_id,message_id",
    }));
  }
  if (error) {
    const em = String(error.message || "");
    if (/author_roles|mention_user_ids|reply_to_|author_display_name/i.test(em)) {
      const rowNoMeta = { ...working };
      let stripped = false;
      if (/author_roles/i.test(em)) {
        delete rowNoMeta.author_roles;
        stripped = true;
      }
      if (/mention_user_ids/i.test(em)) {
        delete rowNoMeta.mention_user_ids;
        stripped = true;
      }
      if (/author_display_name/i.test(em)) {
        delete rowNoMeta.author_display_name;
        stripped = true;
      }
      if (/reply_to_message_id|reply_to_author|reply_to_content/i.test(em)) {
        delete rowNoMeta.reply_to_message_id;
        delete rowNoMeta.reply_to_author_id;
        delete rowNoMeta.reply_to_author_tag;
        delete rowNoMeta.reply_to_content;
        stripped = true;
      }
      if (stripped) {
        ({ error } = await supabase.from("archive_messages").upsert(rowNoMeta, {
          onConflict: "channel_id,message_id",
        }));
      }
    }
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
    .setTitle("Channel cleared")
    .setColor(0x3ba55d)
    .setDescription("Go to **6xs.lol** to view history.")
    .addFields({
      name: "View history",
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

const RESERVED_PROFILE_SLUGS = new Set([
  "auth",
  "archive",
  "api",
  "admin",
  "callback",
  "casino",
  "favicon.ico",
  "robots.txt",
  "profile",
  "static",
  "assets",
  "oauth",
  "wp",
]);

function normalizeProfileSlug(raw, userId) {
  let s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  s = s.slice(0, 32);
  if (s.length < 3) {
    const tail = String(userId || "0")
      .replace(/\D/g, "")
      .slice(-8);
    s = `u_${tail || "user"}`.slice(0, 32);
  }
  return s;
}

function isReservedProfileSlug(slug) {
  return (
    !slug ||
    RESERVED_PROFILE_SLUGS.has(String(slug).toLowerCase()) ||
    /\./.test(slug) ||
    !/^[a-z0-9_]+$/.test(slug)
  );
}

async function archiveMessageStats(supabase, guildId, authorId) {
  const gid = String(guildId);
  const uid = String(authorId);
  const { count, error } = await supabase
    .from("archive_messages")
    .select("*", { count: "exact", head: true })
    .eq("guild_id", gid)
    .eq("author_id", uid);
  if (error) return { error: error.message, total: 0, first_at: null, last_at: null };
  const total = count ?? 0;
  if (total <= 0) return { error: null, total: 0, first_at: null, last_at: null };
  const [{ data: firstRow, error: e1 }, { data: lastRow, error: e2 }] = await Promise.all([
    supabase
      .from("archive_messages")
      .select("created_at_discord")
      .eq("guild_id", gid)
      .eq("author_id", uid)
      .order("created_at_discord", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("archive_messages")
      .select("created_at_discord")
      .eq("guild_id", gid)
      .eq("author_id", uid)
      .order("created_at_discord", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (e1 || e2) {
    return { error: (e1 || e2).message, total, first_at: null, last_at: null };
  }
  return {
    error: null,
    total,
    first_at: firstRow?.created_at_discord ?? null,
    last_at: lastRow?.created_at_discord ?? null,
  };
}

function sanitizeProfileLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 5)) {
    const label = String(item?.label || "")
      .trim()
      .slice(0, 60);
    let url = String(item?.url || "").trim();
    if (!label || !url) continue;
    if (!/^https:\/\//i.test(url)) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") continue;
      out.push({ label, url: u.href.slice(0, 500) });
    } catch {
      /* skip */
    }
  }
  return out;
}

async function pickAvailableSlug(supabase, userId, baseSlug) {
  const uid = String(userId);
  let b = normalizeProfileSlug(baseSlug, uid);
  if (isReservedProfileSlug(b)) b = normalizeProfileSlug(`u_${uid.slice(-12)}`, uid);
  const stem = b.replace(/_\d+$/g, "") || "u";
  for (let n = 0; n < 100; n++) {
    const cand = (n === 0 ? b : `${stem}_${n}`).slice(0, 32);
    const { data, error } = await supabase.from("user_bio_profiles").select("user_id").eq("slug", cand).maybeSingle();
    if (error) continue;
    if (!data || String(data.user_id) === uid) return cand;
  }
  return normalizeProfileSlug(`u_${uid}`, uid).slice(0, 32);
}

async function ensureUserBioProfile(supabase, guildId, userId, discordUsername) {
  const gid = String(guildId);
  const uid = String(userId);
  const { data: row, error: readErr } = await supabase.from("user_bio_profiles").select("*").eq("user_id", uid).maybeSingle();
  if (readErr && !/user_bio_profiles|schema cache/i.test(String(readErr.message || ""))) {
    console.warn("[profile] read failed:", readErr.message);
  }
  if (row) return row;
  const slug = await pickAvailableSlug(supabase, uid, discordUsername || `user_${uid.slice(-6)}`);
  const insert = {
    user_id: uid,
    guild_id: gid,
    slug,
    bio: "",
    links: [],
    profile_display_name: null,
    top_role_override: null,
    updated_at: new Date().toISOString(),
  };
  const ins = await supabase.from("user_bio_profiles").insert(insert).select("*").maybeSingle();
  if (ins.error) {
    const again = await supabase.from("user_bio_profiles").select("*").eq("user_id", uid).maybeSingle();
    if (again.data) return again.data;
    throw new Error(ins.error.message);
  }
  return ins.data;
}

async function fetchMemberProfileDiscord(bot, guildId, userId) {
  try {
    const gid = String(guildId);
    const uid = String(userId);
    const g = await bot.guilds.fetch(gid);
    const m = await g.members.fetch({ user: uid, force: true });
    const tr = m.roles.highest;
    const topRole =
      tr && tr.id !== g.id && tr.name !== "@everyone"
        ? {
            name: String(tr.name),
            color: tr.color,
            hex: typeof tr.hexColor === "string" ? tr.hexColor : null,
          }
        : null;
    const roles = [...m.roles.cache.values()]
      .filter((r) => String(r.id) !== String(g.id))
      .sort((a, b) => (b.position || 0) - (a.position || 0))
      .map((r) => ({
        id: String(r.id),
        name: String(r.name || "").slice(0, 80),
        position: typeof r.position === "number" && Number.isFinite(r.position) ? r.position : 0,
        color: typeof r.color === "number" ? r.color : 0,
        hex: typeof r.hexColor === "string" && r.hexColor && r.hexColor.toLowerCase() !== "#000000" ? r.hexColor : null,
      }));
    return {
      username: m.user.username,
      global_name: m.user.globalName || null,
      display_name: m.displayName,
      avatar_url: m.displayAvatarURL({ size: 256, extension: "png" }),
      top_role: topRole,
      roles,
      joined_at: m.joinedAt ? m.joinedAt.toISOString() : null,
      account_created_at: m.user.createdAt ? m.user.createdAt.toISOString() : null,
    };
  } catch {
    return null;
  }
}

function formatProfileDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

const DEFAULT_BIO_DISPLAY_SETTINGS = {
  accent: "#8b5cf6",
  text: "#fafafa",
  background: "#09090b",
  card: "#18181b",
  border: "#27272a",
  muted: "#a1a1aa",
  avatar_blur: 0,
  avatar_opacity: 100,
  profile_gradient: false,
  show_roles: true,
  show_stats: true,
  show_bio: true,
  show_links: true,
  bg_audio_url: "",
  bg_video_url: "",
  bg_overlay_blur: 18,
  bg_overlay_dim: 0.48,
  glass_blur: 18,
  glass_alpha: 0.52,
  typewriter_bio: false,
  lanyard_enabled: true,
  particles: "none",
  custom_cursor_url: "",
  clipboard_items: [],
};

function sanitizeBioHex6(val, fallback) {
  const s = String(val || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return fallback;
}

function sanitizeBiolinkHttpsUrl(val) {
  const s = String(val || "").trim().slice(0, 900);
  if (!/^https:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    return s;
  } catch {
    return "";
  }
}

function sanitizeBiolinkParticles(v) {
  const m = String(v || "none").toLowerCase();
  if (["snow", "rain", "stars", "glitch"].includes(m)) return m;
  return "none";
}

function sanitizeClipboardItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw.slice(0, 6)) {
    const label = String(it?.label || "")
      .trim()
      .slice(0, 48);
    const value = String(it?.value || "")
      .trim()
      .slice(0, 400);
    if (!label || !value) continue;
    out.push({ label, value });
  }
  return out;
}

function mergeBioDisplaySettings(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULT_BIO_DISPLAY_SETTINGS };
  out.accent = sanitizeBioHex6(o.accent, out.accent);
  out.text = sanitizeBioHex6(o.text, out.text);
  out.background = sanitizeBioHex6(o.background, out.background);
  out.card = sanitizeBioHex6(o.card, out.card);
  out.border = sanitizeBioHex6(o.border, out.border);
  out.muted = sanitizeBioHex6(o.muted, out.muted);
  out.avatar_blur = Math.min(24, Math.max(0, Math.round(Number(o.avatar_blur) || 0)));
  out.avatar_opacity = Math.min(100, Math.max(20, Math.round(Number(o.avatar_opacity) || 100)));
  out.profile_gradient = Boolean(o.profile_gradient);
  out.show_roles = o.show_roles !== false;
  out.show_stats = o.show_stats !== false;
  out.show_bio = o.show_bio !== false;
  out.show_links = o.show_links !== false;
  out.bg_audio_url = sanitizeBiolinkHttpsUrl(o.bg_audio_url);
  out.bg_video_url = sanitizeBiolinkHttpsUrl(o.bg_video_url);
  out.bg_overlay_blur = Math.min(48, Math.max(0, Math.round(Number(o.bg_overlay_blur) || 18)));
  out.bg_overlay_dim = Math.min(0.92, Math.max(0, Number(o.bg_overlay_dim) || 0.48));
  if (!Number.isFinite(out.bg_overlay_dim)) out.bg_overlay_dim = 0.48;
  out.glass_blur = Math.min(48, Math.max(0, Math.round(Number(o.glass_blur) || 16)));
  out.glass_alpha = Math.min(0.95, Math.max(0.12, Number(o.glass_alpha) || 0.52));
  if (!Number.isFinite(out.glass_alpha)) out.glass_alpha = 0.52;
  out.typewriter_bio = Boolean(o.typewriter_bio);
  out.lanyard_enabled = o.lanyard_enabled !== false;
  out.particles = sanitizeBiolinkParticles(o.particles);
  out.custom_cursor_url = sanitizeBiolinkHttpsUrl(o.custom_cursor_url);
  out.clipboard_items = sanitizeClipboardItems(o.clipboard_items);
  return out;
}

function bioRolePillStyle(r) {
  const hx = r?.hex;
  if (typeof hx === "string" && /^#[0-9a-fA-F]{6}$/i.test(hx) && hx.toLowerCase() !== "#000000") {
    const c = escapeHtml(hx);
    return `border-color:${c};color:${c};background:rgba(0,0,0,0.32)`;
  }
  const col = Number(r?.color);
  if (!col) return "border-color:#52525b;color:#e4e4e7;background:rgba(0,0,0,0.32)";
  const R = (col >> 16) & 255;
  const G = (col >> 8) & 255;
  const B = col & 255;
  return `border-color:rgb(${R},${G},${B});color:rgb(${R},${G},${B});background:rgba(0,0,0,0.32)`;
}

function bioCardHexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return [24, 24, 27];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function bioProfilePageHtml(siteBase, payload) {
  const base = siteBase.replace(/\/$/, "");
  const {
    slug,
    profile,
    stats,
    discordMeta,
    viewerId,
    profileUrl,
  } = payload;
  const s = mergeBioDisplaySettings(profile?.display_settings);
  const headline = escapeHtml(
    profile?.profile_display_name ||
      discordMeta?.display_name ||
      discordMeta?.global_name ||
      discordMeta?.username ||
      slug,
  );
  const userLine = discordMeta
    ? escapeHtml(
        `@${discordMeta.username}` +
          (discordMeta.global_name && discordMeta.global_name !== discordMeta.username
            ? ` · ${discordMeta.global_name}`
            : ""),
      )
    : escapeHtml(`@${slug}`);
  const rawBio = String(profile?.bio || "");
  const bioBlock =
    s.show_bio && rawBio
      ? s.typewriter_bio
        ? `<section class="panel"><h2 class="panel-title">About</h2><div id="bio-tw" class="bio typewriter" aria-live="polite"></div></section>`
        : `<section class="panel"><h2 class="panel-title">About</h2><div class="bio">${escapeHtml(rawBio).replace(/\n/g, "<br/>")}</div></section>`
      : "";
  const clipItems = Array.isArray(s.clipboard_items) ? s.clipboard_items : [];
  const clipboardHtml =
    clipItems.length > 0
      ? `<section class="panel"><h2 class="panel-title">Clipboard</h2><div class="clip-grid">${clipItems
          .map(
            (c, idx) =>
              `<button type="button" class="clip-row" data-clip-idx="${idx}"><span class="clip-label">${escapeHtml(c.label)}</span><span class="clip-faux">${escapeHtml(c.value.length > 52 ? `${c.value.slice(0, 52)}…` : c.value)}</span><span class="clip-hint">Copy</span></button>`,
          )
          .join("")}</div></section>`
      : "";
  const links = Array.isArray(profile?.links) ? profile.links : [];
  const linksHtml =
    s.show_links && links.length > 0
      ? `<section class="panel"><h2 class="panel-title">Links</h2><div class="links">${links
          .map(
            (l) =>
              `<a class="link-chip" href="${escapeHtml(l.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(l.label)}</a>`,
          )
          .join("")}</div></section>`
      : "";
  const rolesArr = Array.isArray(discordMeta?.roles) ? discordMeta.roles : [];
  const rolesHtml =
    s.show_roles && rolesArr.length > 0
      ? `<section class="panel"><h2 class="panel-title">Server roles</h2>${
          profile?.top_role_override
            ? `<p class="tagline">${escapeHtml(profile.top_role_override)}</p>`
            : ""
        }<div class="roles-grid">${rolesArr
          .map(
            (r) =>
              `<span class="role-chip" style="${bioRolePillStyle(r)}">${escapeHtml(String(r.name || ""))}</span>`,
          )
          .join("")}</div></section>`
      : s.show_roles && profile?.top_role_override
        ? `<section class="panel"><h2 class="panel-title">Tag</h2><p class="tagline solo">${escapeHtml(profile.top_role_override)}</p></section>`
        : "";
  const total = stats?.total ?? 0;
  const span =
    stats?.first_at && stats?.last_at
      ? `${formatProfileDate(stats.first_at)} → ${formatProfileDate(stats.last_at)}`
      : "—";
  const statJoin = discordMeta?.joined_at ? formatProfileDate(discordMeta.joined_at) : "—";
  const statAcct = discordMeta?.account_created_at ? formatProfileDate(discordMeta.account_created_at) : "—";
  const statsHtml = s.show_stats
    ? `<section class="panel"><h2 class="panel-title">Archive stats</h2><div class="stats">
        <div class="stat"><b>${escapeHtml(String(total))}</b><span>Archived messages</span></div>
        <div class="stat"><b>${escapeHtml(span)}</b><span>First → last log</span></div>
        <div class="stat"><b>${escapeHtml(statJoin)}</b><span>In this server since</span></div>
        <div class="stat"><b>${escapeHtml(statAcct)}</b><span>Discord account</span></div>
      </div></section>`
    : "";
  const canEdit =
    viewerId && profile?.user_id && String(viewerId) === String(profile.user_id);
  const editBtn = canEdit
    ? `<p class="edit-row"><a class="btn" href="${escapeHtml(base)}/profile/edit">Customize profile</a></p>`
    : "";
  const bgLayers = s.profile_gradient
    ? `linear-gradient(165deg, ${s.accent}33 0%, transparent 42%), radial-gradient(ellipse 90% 55% at 50% -8%, ${s.accent}26, transparent), ${s.background}`
    : `radial-gradient(ellipse 85% 50% at 50% -12%, ${s.accent}22, transparent), ${s.background}`;
  const avBlur = Number(s.avatar_blur) || 0;
  const avOp = (Number(s.avatar_opacity) || 100) / 100;
  const avatarBlock = discordMeta?.avatar_url
    ? `<div class="avatar-wrap"><img class="avatar" src="${escapeHtml(discordMeta.avatar_url)}" alt="" style="filter:blur(${avBlur}px);opacity:${avOp};" /></div>`
    : "";
  const hasVideo = Boolean(s.bg_video_url);
  const cardRgb = bioCardHexToRgb(s.card);
  const heroGlassBg = `rgba(${cardRgb[0]},${cardRgb[1]},${cardRgb[2]},${Number(s.glass_alpha).toFixed(3)})`;
  const overlayBlur = Number(s.bg_overlay_blur) || 18;
  const overlayDim = Number(s.bg_overlay_dim);
  const overlayDimSafe = Number.isFinite(overlayDim) ? Math.min(0.92, Math.max(0, overlayDim)) : 0.48;
  const glassBlurPx = Number(s.glass_blur) || 16;
  const audioHtml = s.bg_audio_url
    ? `<audio class="biolink-audio" src="${escapeHtml(s.bg_audio_url)}" loop playsinline preload="auto"></audio><p class="audio-hint" id="audio-hint">Tap anywhere to start background audio</p>`
    : "";
  const videoHtml = hasVideo
    ? `<video class="biolink-bgvid" muted loop playsinline autoplay disablepictureinpicture><source src="${escapeHtml(s.bg_video_url)}" /></video><div class="biolink-overlay" style="backdrop-filter:blur(${overlayBlur}px);-webkit-backdrop-filter:blur(${overlayBlur}px);background:rgba(0,0,0,${overlayDimSafe.toFixed(3)});"></div>`
    : "";
  const cursorCss = s.custom_cursor_url
    ? `cursor:url("${String(s.custom_cursor_url).replace(/"/g, "")}") 0 0, auto;`
    : "";
  const bodyBgStyle = hasVideo ? "#030303" : bgLayers;
  const bootPayload = {
    bio: rawBio,
    uid: String(profile?.user_id || ""),
    tw: Boolean(s.typewriter_bio && rawBio.length),
    lanyard: Boolean(s.lanyard_enabled && profile?.user_id),
    particles: s.particles || "none",
    audio: Boolean(s.bg_audio_url),
    clip: clipItems,
  };
  const bootJson = JSON.stringify(bootPayload).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${headline} — 6xs</title>
  <style>
    :root {
      --bg: ${s.background};
      --card: ${s.card};
      --border: ${s.border};
      --text: ${s.text};
      --muted: ${s.muted};
      --accent: ${s.accent};
    }
    * { box-sizing: border-box; }
    .biolink-bgvid {
      position: fixed;
      inset: 0;
      z-index: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
    }
    .biolink-overlay {
      position: fixed;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }
    .biolink-pcanvas {
      position: fixed;
      inset: 0;
      z-index: 2;
      pointer-events: none;
    }
    .biolink-audio {
      position: absolute;
      width: 0;
      height: 0;
      opacity: 0;
      pointer-events: none;
    }
    .audio-hint {
      position: fixed;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 8;
      font-size: 11px;
      color: var(--muted);
      opacity: 0.85;
      pointer-events: none;
      max-width: 90vw;
      text-align: center;
      transition: opacity 0.4s;
    }
    .audio-hint.done { opacity: 0; }
    body.biolink-page {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: ${bodyBgStyle};
      color: var(--text);
      padding: 28px 16px 56px;
      ${cursorCss}
    }
    body.biolink-has-video { background: ${bodyBgStyle} !important; }
    .wrap {
      position: relative;
      z-index: 3;
      max-width: 440px;
      margin: 0 auto;
    }
    .hero {
      background: ${heroGlassBg};
      backdrop-filter: blur(${glassBlurPx}px);
      -webkit-backdrop-filter: blur(${glassBlurPx}px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 22px;
      padding: 28px 22px 22px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
    }
    @keyframes biolink-avatar-glow {
      0%, 100% { box-shadow: 0 0 0 3px ${s.accent}55, 0 10px 36px rgba(0,0,0,0.45); }
      50% { box-shadow: 0 0 0 5px ${s.accent}88, 0 14px 48px ${s.accent}33; }
    }
    .avatar-wrap {
      width: 108px;
      height: 108px;
      margin: 0 auto 18px;
      border-radius: 50%;
      overflow: hidden;
      border: 2px solid rgba(255,255,255,0.1);
      animation: biolink-avatar-glow 3.2s ease-in-out infinite;
      background: #0c0c0e;
    }
    .avatar { width: 100%; height: 100%; object-fit: cover; display: block; transform: scale(1.04); }
    h1 { margin: 0 0 8px; font-size: 1.55rem; font-weight: 700; text-align: center; letter-spacing: -0.02em; }
    .userline { text-align: center; color: var(--muted); font-size: 14px; margin-bottom: 6px; }
    .identity-strip { text-align: center; margin-bottom: 10px; min-height: 28px; }
    .badge-row { display: inline-flex; flex-wrap: wrap; gap: 6px; justify-content: center; align-items: center; margin-bottom: 6px; }
    .badge-row svg { width: 22px; height: 22px; opacity: 0.95; }
    .presence-row { font-size: 12px; color: var(--muted); line-height: 1.4; }
    .presence-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    .presence-dot.online { background: #3ba55d; box-shadow: 0 0 10px #3ba55d; }
    .presence-dot.idle { background: #faa61a; }
    .presence-dot.dnd { background: #ed4245; }
    .presence-dot.offline { background: #747f8d; }
    .panel {
      margin-top: 14px;
      background: rgba(0,0,0,0.18);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 14px;
      padding: 14px 14px 16px;
    }
    .panel-title {
      margin: 0 0 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }
    .tagline { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-style: italic; }
    .tagline.solo { margin: 0; }
    .roles-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .role-chip {
      font-size: 12px;
      font-weight: 600;
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid;
      max-width: 100%;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .stat {
      background: rgba(0,0,0,0.28);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 10px;
      text-align: center;
    }
    .stat b { display: block; font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; color: var(--text); }
    .stat span { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.35; }
    .bio { white-space: pre-wrap; line-height: 1.55; color: var(--muted); font-size: 14px; min-height: 1.2em; }
    .bio.typewriter::after { content: "▍"; animation: blink 0.9s step-end infinite; color: var(--accent); margin-left: 1px; }
    @keyframes blink { 50% { opacity: 0; } }
    .clip-grid { display: flex; flex-direction: column; gap: 8px; }
    .clip-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.25);
      color: var(--text);
      font: inherit;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
    }
    .clip-row:hover { border-color: var(--accent); box-shadow: 0 0 0 1px ${s.accent}44; transform: translateY(-1px); }
    .clip-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); flex: 0 0 100%; }
    .clip-faux { font-size: 12px; color: var(--text); word-break: break-all; flex: 1; min-width: 0; }
    .clip-hint { font-size: 11px; color: var(--accent); font-weight: 600; }
    .links { display: flex; flex-wrap: wrap; gap: 8px; }
    .link-chip {
      flex: 1 1 40%;
      text-align: center;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      color: #fff;
      background: linear-gradient(135deg, var(--accent), ${s.accent}99);
      border: 1px solid ${s.accent}66;
      min-width: 0;
      transition: transform 0.2s, box-shadow 0.2s, filter 0.2s;
    }
    .link-chip:hover {
      transform: translateY(-3px) scale(1.03);
      box-shadow: 0 12px 28px ${s.accent}55, 0 0 24px ${s.accent}44;
      filter: brightness(1.08);
    }
    .fine { text-align: center; font-size: 12px; color: var(--muted); margin-top: 22px; position: relative; z-index: 3; }
    .fine a { color: var(--accent); text-decoration: none; }
    .fine a:hover { text-decoration: underline; }
    .edit-row { text-align: center; margin-top: 14px; }
    .btn {
      display: inline-block;
      padding: 11px 20px;
      border-radius: 12px;
      font-weight: 700;
      text-decoration: none;
      background: var(--accent);
      color: #fff;
      font-size: 14px;
      box-shadow: 0 8px 24px ${s.accent}55;
    }
    .btn:hover { filter: brightness(1.08); }
  </style>
</head>
<body class="biolink-page${hasVideo ? " biolink-has-video" : ""}">
  ${audioHtml}
  ${videoHtml}
  <canvas id="biolink-pcanvas" class="biolink-pcanvas" aria-hidden="true"></canvas>
  <script type="application/json" id="biolink-boot">${bootJson}</script>
  <div class="wrap">
    <div class="hero">
      ${avatarBlock}
      <h1>${headline}</h1>
      <div class="userline">${userLine}</div>
      <div class="identity-strip">
        <div id="badge-row" class="badge-row"></div>
        <div id="presence-row" class="presence-row"></div>
      </div>
      ${statsHtml}
      ${rolesHtml}
      ${bioBlock}
      ${clipboardHtml}
      ${linksHtml}
      ${editBtn}
    </div>
    <p class="fine"><a href="${escapeHtml(base)}">6xs.lol</a> · <a href="${escapeHtml(profileUrl)}">${escapeHtml(profileUrl.replace(/^https?:\/\//, ""))}</a></p>
  </div>
  <script>
(function () {
  var el = document.getElementById("biolink-boot");
  if (!el) return;
  var BOOT = {};
  try { BOOT = JSON.parse(el.textContent || "{}"); } catch (e) { return; }
  function typewriter() {
    if (!BOOT.tw) return;
    var node = document.getElementById("bio-tw");
    if (!node || !BOOT.bio) return;
    var text = BOOT.bio;
    var i = 0;
    function tick() {
      if (i <= text.length) {
        node.textContent = text.slice(0, i);
        i++;
        setTimeout(tick, i > 2 && text[i - 2] === "." ? 120 : 28);
      } else node.classList.remove("typewriter");
    }
    tick();
  }
  typewriter();
  function playAudioOnce() {
    var a = document.querySelector(".biolink-audio");
    var h = document.getElementById("audio-hint");
    if (!a) return;
    a.volume = 0.35;
    a.play().then(function () { if (h) h.classList.add("done"); }).catch(function () {});
    document.removeEventListener("click", playAudioOnce);
    document.removeEventListener("touchstart", playAudioOnce);
  }
  if (BOOT.audio) {
    document.addEventListener("click", playAudioOnce);
    document.addEventListener("touchstart", playAudioOnce, { passive: true });
  }
  function copyFromIdx(idx) {
    var arr = BOOT.clip || [];
    if (!arr[idx]) return;
    var v = arr[idx].value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function () {}).catch(function () {});
    }
  }
  document.querySelectorAll(".clip-row").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var i = parseInt(btn.getAttribute("data-clip-idx"), 10);
      if (!isNaN(i)) copyFromIdx(i);
    });
  });
  var FLAG_SVG = {
    staff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5zm0 9l2.5-1.25L12 8.5l-2.5 1.25L12 11zm0 2.5l-5-2.5-5 2.5L12 22l10-8.5-5-2.5-5 2.5z"/></svg>',
    partner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#5865F2" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
    hype: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F47B67" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    nitro: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FF73FA" d="M4 4h16v4l-8 5v7l-3-2v-5L4 8V4z"/></svg>',
    early: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F0B232" d="M12 2L4 9v13h16V9l-8-7zm0 3.17L16.17 10H7.83L12 5.17zM18 19H6v-7h12v7z"/></svg>',
    dev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#3BA55D" d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>'
  };
  function flagBadges(flags) {
    var html = "";
    if (!flags) return html;
    if (flags & 1) html += FLAG_SVG.staff;
    if (flags & 1 << 1) html += FLAG_SVG.partner;
    if (flags & (1 << 3)) html += FLAG_SVG.dev;
    if (flags & (1 << 9)) html += FLAG_SVG.early;
    if (flags & ((1 << 6) | (1 << 7) | (1 << 8))) html += FLAG_SVG.hype;
    return html;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }
  function lanyard() {
    if (!BOOT.lanyard || !BOOT.uid) return;
    fetch("https://api.lanyard.rest/v1/users/" + encodeURIComponent(BOOT.uid))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.success || !j.data) return;
        var d = j.data;
        var br = document.getElementById("badge-row");
        var pr = document.getElementById("presence-row");
        if (br && d.discord_user) {
          var f = d.discord_user.public_flags || 0;
          var extra = "";
          if (d.discord_user.premium_type > 0) extra += FLAG_SVG.nitro;
          br.innerHTML = flagBadges(f) + extra;
        }
        if (pr) {
          var stRaw = d.discord_status || "offline";
          var st = ["online", "idle", "dnd", "offline"].indexOf(stRaw) >= 0 ? stRaw : "offline";
          var dot = '<span class="presence-dot ' + st + '"></span>';
          var act = (d.activities && d.activities[0] && d.activities[0].name) ? d.activities[0].name : "";
          var det = (d.activities && d.activities[0] && d.activities[0].details) ? " — " + d.activities[0].details : "";
          var line = act ? "Playing " + esc(act) + esc(det) : "Discord · " + esc(stRaw);
          pr.innerHTML = dot + '<span style="vertical-align:middle">' + line + "</span>";
        }
      })
      .catch(function () {});
  }
  lanyard();
  var cv = document.getElementById("biolink-pcanvas");
  if (cv && BOOT.particles && BOOT.particles !== "none") {
    var ctx = cv.getContext("2d");
    var W, H, parts = [];
    function resize() {
      W = cv.width = innerWidth;
      H = cv.height = innerHeight;
    }
    resize();
    addEventListener("resize", resize);
    var n = BOOT.particles === "stars" ? 90 : BOOT.particles === "glitch" ? 40 : 70;
    for (var i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        s: Math.random() * 2.2 + 0.3,
        v: Math.random() * 1.5 + 0.4,
        vx: (Math.random() - 0.5) * (BOOT.particles === "glitch" ? 3 : 0.2),
      });
    }
    function tick() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (BOOT.particles === "rain") {
          ctx.fillStyle = "rgba(200,220,255,0.45)";
          p.y += p.v * 6;
          p.x += p.vx;
          if (p.y > H) { p.y = -4; p.x = Math.random() * W; }
          ctx.fillRect(p.x, p.y, 1.2, p.s * 10);
        } else if (BOOT.particles === "snow") {
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          p.y += p.v * 0.8;
          p.x += Math.sin(p.y * 0.02) * 0.8;
          if (p.y > H) { p.y = -2; p.x = Math.random() * W; }
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.s, 0, 6.28);
          ctx.fill();
        } else if (BOOT.particles === "stars") {
          p.tw = (p.tw || Math.random() * 10) + 0.04;
          var o = 0.25 + Math.sin(p.tw) * 0.35;
          ctx.globalAlpha = o;
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.s, 0, 6.28);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = Math.random() > 0.5 ? "rgba(255,0,255,0.2)" : "rgba(0,255,255,0.18)";
          p.x += (Math.random() - 0.5) * 10;
          p.y += (Math.random() - 0.5) * 8;
          if (p.x < 0) p.x = W;
          if (p.x > W) p.x = 0;
          if (p.y < 0) p.y = H;
          if (p.y > H) p.y = 0;
          ctx.fillRect(p.x, p.y, 2, 12);
        }
      }
      requestAnimationFrame(tick);
    }
    tick();
  }
})();
  </script>
</body>
</html>`;
}

function profileEditPageHtml(siteBase, user, profile, stats, errMsg) {
  const base = siteBase.replace(/\/$/, "");
  const slug = escapeHtml(profile?.slug || "");
  const disp = escapeHtml(profile?.profile_display_name || "");
  const roleOv = escapeHtml(profile?.top_role_override || "");
  const bio = escapeHtml(profile?.bio || "");
  const links = Array.isArray(profile?.links) ? profile.links : [];
  const theme = mergeBioDisplaySettings(profile?.display_settings);
  const linkRows = [];
  for (let i = 0; i < 5; i++) {
    const L = links[i] || {};
    linkRows.push(`<div class="link-pair"><input name="link_label_${i}" type="text" placeholder="Label" value="${escapeHtml(L.label || "")}" maxlength="60" />
      <input name="link_url_${i}" type="url" placeholder="https://…" value="${escapeHtml(L.url || "")}" /></div>`);
  }
  const clipItems = Array.isArray(theme.clipboard_items) ? theme.clipboard_items : [];
  const clipRows = [];
  for (let i = 0; i < 5; i++) {
    const C = clipItems[i] || {};
    clipRows.push(`<div class="link-pair"><input name="clip_label_${i}" type="text" placeholder="Label" value="${escapeHtml(C.label || "")}" maxlength="48" />
      <input name="clip_value_${i}" type="text" placeholder="Value to copy" value="${escapeHtml(C.value || "")}" maxlength="400" /></div>`);
  }
  const particlePresets = ["none", "snow", "rain", "stars", "glitch"];
  const particleOpts = particlePresets
    .map((p) => `<option value="${p}"${theme.particles === p ? " selected" : ""}>${p}</option>`)
    .join("");
  const err = errMsg ? `<p class="err">${escapeHtml(errMsg)}</p>` : "";
  const stTotal = stats?.total ?? 0;
  const stSpan =
    stats?.first_at && stats?.last_at
      ? `${formatProfileDate(stats.first_at)} → ${formatProfileDate(stats.last_at)}`
      : "—";
  const hx = (k) => escapeHtml(theme[k] || "");
  const chk = (k) => (theme[k] ? "checked" : "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edit profile — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --card:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --accent:#8b5cf6; --err:#ed4245; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family:ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:var(--text); padding:24px 16px 48px; }
    .wrap { max-width:620px; margin:0 auto; }
    h1 { font-size:1.35rem; margin:0 0 8px; }
    p.sub { color:var(--muted); margin:0 0 20px; font-size:14px; line-height:1.45; }
    .sec { margin-top:22px; padding-top:18px; border-top:1px solid var(--border); }
    .sec h2 { font-size:13px; text-transform:uppercase; letter-spacing:0.1em; color:var(--muted); margin:0 0 12px; }
    label { display:block; font-size:12px; color:var(--muted); margin:14px 0 6px; }
    input[type="text"], input[type="url"], textarea {
      width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:#1e2128; color:var(--text); font-size:14px; }
    textarea { min-height:120px; resize:vertical; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .color-row { display:flex; align-items:center; gap:10px; }
    .color-row input[type="color"] { width:48px; height:40px; border:1px solid var(--border); border-radius:8px; padding:0; cursor:pointer; background:#1e2128; }
    .color-row input[type="text"] { flex:1; }
    .row-range { display:flex; align-items:center; gap:12px; }
    .row-range input[type="range"] { flex:1; }
    .toggles { display:flex; flex-wrap:wrap; gap:12px 18px; margin-top:8px; font-size:14px; }
    .toggles label { display:flex; align-items:center; gap:8px; margin:0; cursor:pointer; color:var(--text); }
    .toggles input { width:18px; height:18px; }
    .link-pair { display:grid; grid-template-columns:1fr 2fr; gap:8px; margin-bottom:8px; }
    .btn { margin-top:22px; padding:12px 20px; border:none; border-radius:10px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; font-size:15px; }
    .btn:hover { filter:brightness(1.08); }
    .err { color:var(--err); font-size:14px; }
    .stats-preview { background:#1e2128; border:1px solid var(--border); border-radius:10px; padding:14px; margin-bottom:20px; font-size:13px; color:var(--muted); }
    .stats-preview strong { color:var(--text); }
    .nav { margin-bottom:20px; font-size:14px; }
    .nav a { color:var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav"><a href="${escapeHtml(base)}/archive">← Archives</a> · <a href="${escapeHtml(base)}/${slug}">View profile</a></div>
    <h1>Edit your biolink</h1>
    <p class="sub">Signed in as <strong>${escapeHtml(user.global_name || user.username || "")}</strong>. Public URL: <strong>${escapeHtml(base)}/</strong><span id="slug-preview">${slug}</span><br/>Run <code style="font-size:12px;color:#a1a1aa">supabase_user_bio_migrate.sql</code> in Supabase if theme save errors (adds <code style="font-size:12px">display_settings</code>).</p>
    <div class="stats-preview">Archive sync: <strong>${escapeHtml(String(stTotal))}</strong> messages · <strong>${escapeHtml(stSpan)}</strong> · All server roles load live from Discord on your public page.</div>
    ${err}
    <form id="pf">
      <label for="slug">URL slug (6xs.lol/…)</label>
      <input id="slug" name="slug" type="text" value="${slug}" maxlength="32" pattern="[a-z0-9_]{3,32}" autocomplete="off" />
      <label for="profile_display_name">Headline (optional)</label>
      <input id="profile_display_name" name="profile_display_name" type="text" value="${disp}" maxlength="80" placeholder="Defaults to Discord display name" />
      <label for="top_role_override">Optional tagline above roles</label>
      <input id="top_role_override" name="top_role_override" type="text" value="${roleOv}" maxlength="80" placeholder="e.g. Host · Designer (shown above role chips)" />

      <div class="sec">
        <h2>Colors &amp; backdrop</h2>
        <div class="grid2">
          <div><label>Accent</label><div class="color-row"><input type="color" id="ts_accent" value="${hx("accent")}" /><input type="text" id="ts_accent_hex" maxlength="7" value="${hx("accent")}" pattern="#[0-9a-fA-F]{6}" /></div></div>
          <div><label>Text</label><div class="color-row"><input type="color" id="ts_text" value="${hx("text")}" /><input type="text" id="ts_text_hex" maxlength="7" value="${hx("text")}" /></div></div>
          <div><label>Page background</label><div class="color-row"><input type="color" id="ts_background" value="${hx("background")}" /><input type="text" id="ts_background_hex" maxlength="7" value="${hx("background")}" /></div></div>
          <div><label>Card / panels</label><div class="color-row"><input type="color" id="ts_card" value="${hx("card")}" /><input type="text" id="ts_card_hex" maxlength="7" value="${hx("card")}" /></div></div>
          <div><label>Borders</label><div class="color-row"><input type="color" id="ts_border" value="${hx("border")}" /><input type="text" id="ts_border_hex" maxlength="7" value="${hx("border")}" /></div></div>
          <div><label>Muted text</label><div class="color-row"><input type="color" id="ts_muted" value="${hx("muted")}" /><input type="text" id="ts_muted_hex" maxlength="7" value="${hx("muted")}" /></div></div>
        </div>
        <label class="row-range"><span style="min-width:88px;font-size:12px;color:var(--muted)">Avatar blur</span><input type="range" id="ts_avatar_blur" min="0" max="16" value="${escapeHtml(String(theme.avatar_blur))}" /><span id="lbl_blur" style="min-width:28px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(theme.avatar_blur))}</span></label>
        <label class="row-range"><span style="min-width:88px;font-size:12px;color:var(--muted)">Avatar opacity</span><input type="range" id="ts_avatar_opacity" min="20" max="100" value="${escapeHtml(String(theme.avatar_opacity))}" /><span id="lbl_op" style="min-width:36px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(theme.avatar_opacity))}%</span></label>
        <div class="toggles">
          <label><input type="checkbox" id="ts_profile_gradient" ${chk("profile_gradient")} /> Violet gradient wash</label>
          <label><input type="checkbox" id="ts_show_roles" ${chk("show_roles")} /> Show all server roles</label>
          <label><input type="checkbox" id="ts_show_stats" ${chk("show_stats")} /> Show archive stats</label>
          <label><input type="checkbox" id="ts_show_bio" ${chk("show_bio")} /> Show bio</label>
          <label><input type="checkbox" id="ts_show_links" ${chk("show_links")} /> Show links</label>
        </div>
      </div>

      <div class="sec">
        <h2>Immersive &amp; motion</h2>
        <label for="ts_bg_video">Background video (https — fullscreen, muted, loop)</label>
        <input id="ts_bg_video" type="url" placeholder="https://cdn…/loop.mp4" value="${escapeHtml(theme.bg_video_url || "")}" maxlength="900" />
        <label for="ts_bg_audio">Background audio (https mp3 — loops after first tap)</label>
        <input id="ts_bg_audio" type="url" placeholder="https://…/track.mp3" value="${escapeHtml(theme.bg_audio_url || "")}" maxlength="900" />
        <label for="ts_cursor_url">Custom cursor (https .png or .cur)</label>
        <input id="ts_cursor_url" type="url" placeholder="https://…/cursor.png" value="${escapeHtml(theme.custom_cursor_url || "")}" maxlength="900" />
        <label class="row-range"><span style="min-width:128px;font-size:12px;color:var(--muted)">Video backdrop blur</span><input type="range" id="ts_overlay_blur" min="0" max="40" value="${escapeHtml(String(theme.bg_overlay_blur))}" /><span id="lbl_ob" style="min-width:32px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(theme.bg_overlay_blur))}</span></label>
        <label class="row-range"><span style="min-width:128px;font-size:12px;color:var(--muted)">Video dim overlay</span><input type="range" id="ts_overlay_dim" min="0" max="90" value="${escapeHtml(String(Math.round(Number(theme.bg_overlay_dim) * 100)))}" /><span id="lbl_od" style="min-width:36px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(Math.round(Number(theme.bg_overlay_dim) * 100)))}%</span></label>
        <label class="row-range"><span style="min-width:128px;font-size:12px;color:var(--muted)">Glass card blur</span><input type="range" id="ts_glass_blur" min="4" max="40" value="${escapeHtml(String(theme.glass_blur))}" /><span id="lbl_gb" style="min-width:32px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(theme.glass_blur))}</span></label>
        <label class="row-range"><span style="min-width:128px;font-size:12px;color:var(--muted)">Glass card opacity</span><input type="range" id="ts_glass_alpha" min="12" max="95" value="${escapeHtml(String(Math.round(Number(theme.glass_alpha) * 100)))}" /><span id="lbl_ga" style="min-width:36px;text-align:right;font-size:12px;color:var(--muted)">${escapeHtml(String(Math.round(Number(theme.glass_alpha) * 100)))}%</span></label>
        <label for="ts_particles">Particles (canvas overlay)</label>
        <select id="ts_particles">${particleOpts}</select>
        <div class="toggles" style="margin-top:12px">
          <label><input type="checkbox" id="ts_typewriter_bio" ${theme.typewriter_bio ? "checked" : ""} /> Typewriter bio</label>
          <label><input type="checkbox" id="ts_lanyard_enabled" ${theme.lanyard_enabled !== false ? "checked" : ""} /> Lanyard presence &amp; badges</label>
        </div>
        <label style="margin-top:14px">Clipboard (optional — tap to copy on public page)</label>
        ${clipRows.join("")}
      </div>

      <div class="sec">
        <h2>Content</h2>
        <label for="bio">Bio</label>
        <textarea id="bio" name="bio" maxlength="2000" placeholder="Say something…">${bio}</textarea>
        <label>Links (https only, max 5)</label>
        ${linkRows.join("")}
      </div>
      <button type="submit" class="btn">Save profile</button>
    </form>
  </div>
  <script>
    function bindColorPair(cId, tId) {
      var c = document.getElementById(cId);
      var t = document.getElementById(tId);
      if (!c || !t) return;
      c.addEventListener("input", function () { t.value = c.value; });
      t.addEventListener("input", function () {
        var v = (t.value || "").trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) c.value = v;
      });
    }
    bindColorPair("ts_accent", "ts_accent_hex");
    bindColorPair("ts_text", "ts_text_hex");
    bindColorPair("ts_background", "ts_background_hex");
    bindColorPair("ts_card", "ts_card_hex");
    bindColorPair("ts_border", "ts_border_hex");
    bindColorPair("ts_muted", "ts_muted_hex");
    document.getElementById("ts_avatar_blur").addEventListener("input", function () {
      document.getElementById("lbl_blur").textContent = this.value;
    });
    document.getElementById("ts_avatar_opacity").addEventListener("input", function () {
      document.getElementById("lbl_op").textContent = this.value + "%";
    });
    function bindLbl(id, lbl) {
      var el = document.getElementById(id);
      var l = document.getElementById(lbl);
      if (!el || !l) return;
      el.addEventListener("input", function () {
        l.textContent = id === "ts_overlay_dim" || id === "ts_glass_alpha" ? this.value + "%" : this.value;
      });
    }
    bindLbl("ts_overlay_blur", "lbl_ob");
    bindLbl("ts_overlay_dim", "lbl_od");
    bindLbl("ts_glass_blur", "lbl_gb");
    bindLbl("ts_glass_alpha", "lbl_ga");
    document.getElementById("slug").addEventListener("input", function () {
      document.getElementById("slug-preview").textContent = (this.value || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "…";
    });
    document.getElementById("pf").onsubmit = async function (e) {
      e.preventDefault();
      const links = [];
      for (var i = 0; i < 5; i++) {
        var lb = document.querySelector('[name="link_label_' + i + '"]').value.trim();
        var ur = document.querySelector('[name="link_url_' + i + '"]').value.trim();
        if (lb && ur) links.push({ label: lb, url: ur });
      }
      const clip = [];
      for (var j = 0; j < 5; j++) {
        var cl = document.querySelector('[name="clip_label_' + j + '"]').value.trim();
        var cv = document.querySelector('[name="clip_value_' + j + '"]').value.trim();
        if (cl && cv) clip.push({ label: cl, value: cv });
      }
      function pickHex(cId, tId, fallback) {
        var t = document.getElementById(tId);
        var v = (t && t.value ? t.value : "").trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
        var c = document.getElementById(cId);
        return c && c.value && /^#[0-9a-fA-F]{6}$/.test(c.value) ? c.value : fallback;
      }
      const body = {
        slug: document.getElementById("slug").value.trim(),
        profile_display_name: document.getElementById("profile_display_name").value.trim(),
        top_role_override: document.getElementById("top_role_override").value.trim(),
        bio: document.getElementById("bio").value,
        links: links,
        display_settings: {
          accent: pickHex("ts_accent", "ts_accent_hex", "#8b5cf6"),
          text: pickHex("ts_text", "ts_text_hex", "#fafafa"),
          background: pickHex("ts_background", "ts_background_hex", "#09090b"),
          card: pickHex("ts_card", "ts_card_hex", "#18181b"),
          border: pickHex("ts_border", "ts_border_hex", "#27272a"),
          muted: pickHex("ts_muted", "ts_muted_hex", "#a1a1aa"),
          avatar_blur: parseInt(document.getElementById("ts_avatar_blur").value, 10) || 0,
          avatar_opacity: parseInt(document.getElementById("ts_avatar_opacity").value, 10) || 100,
          profile_gradient: document.getElementById("ts_profile_gradient").checked,
          show_roles: document.getElementById("ts_show_roles").checked,
          show_stats: document.getElementById("ts_show_stats").checked,
          show_bio: document.getElementById("ts_show_bio").checked,
          show_links: document.getElementById("ts_show_links").checked,
          bg_video_url: document.getElementById("ts_bg_video").value.trim(),
          bg_audio_url: document.getElementById("ts_bg_audio").value.trim(),
          custom_cursor_url: document.getElementById("ts_cursor_url").value.trim(),
          bg_overlay_blur: parseInt(document.getElementById("ts_overlay_blur").value, 10) || 0,
          bg_overlay_dim: (parseInt(document.getElementById("ts_overlay_dim").value, 10) || 0) / 100,
          glass_blur: parseInt(document.getElementById("ts_glass_blur").value, 10) || 16,
          glass_alpha: (parseInt(document.getElementById("ts_glass_alpha").value, 10) || 52) / 100,
          particles: document.getElementById("ts_particles").value,
          typewriter_bio: document.getElementById("ts_typewriter_bio").checked,
          lanyard_enabled: document.getElementById("ts_lanyard_enabled").checked,
          clipboard_items: clip,
        },
      };
      try {
        const r = await fetch("/api/profile/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || "Save failed");
        window.location.href = j.public_path || "/";
      } catch (err) {
        alert(err.message || String(err));
      }
    };
  </script>
</body>
</html>`;
}

function cardDeck() {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const suits = ["♠", "♥", "♦", "♣"];
  const deck = [];
  for (const r of ranks) for (const s of suits) deck.push(`${r}${s}`);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J"].includes(rank)) return 10;
  return parseInt(rank, 10) || 0;
}

function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    total += cardValue(r);
    if (r === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function minesMultiplier(tiles, mines, picks) {
  let mult = 1;
  const safePicks = Math.max(0, Math.min(picks, tiles - mines));
  for (let i = 0; i < safePicks; i++) {
    mult *= (tiles - i) / (tiles - mines - i);
  }
  return Number((mult * 0.96).toFixed(4));
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
    SPECIAL_MEDIA_CHANNEL_ID,
    CHANNEL_NUKE_INTERVAL_MS,
    MEDIA_BACKUP_ENABLED,
    MEDIA_BACKUP_BUCKET,
    MEDIA_BACKUP_MAX_BYTES,
    BUNNY_STORAGE_ENDPOINT,
    BUNNY_STORAGE_ACCESS_KEY,
    BUNNY_CDN_BASE,
    ECONOMY_GUILD_ID,
  } = deps;

  const authRedirect = SITE_AUTH_REDIRECT_URI;
  economySupabase = supabase;
  const casinoGuildId = String(ECONOMY_GUILD_ID || ARCHIVE_GUILD_ID || "").trim();
  const mediaChannelId = String(SPECIAL_MEDIA_CHANNEL_ID || "").trim();
  const mediaBackupCfg = {
    enabled: MEDIA_BACKUP_ENABLED !== false,
    bucket: String(MEDIA_BACKUP_BUCKET || "archive-media").trim() || "archive-media",
    maxBytes: Math.max(1, Number(MEDIA_BACKUP_MAX_BYTES || 125 * 1024 * 1024) || 125 * 1024 * 1024),
    provider:
      String(BUNNY_STORAGE_ENDPOINT || "").trim() && String(BUNNY_STORAGE_ACCESS_KEY || "").trim()
        ? "bunny"
        : "supabase",
    bunnyEndpoint: String(BUNNY_STORAGE_ENDPOINT || "").replace(/\/+$/, ""),
    bunnyAccessKey: String(BUNNY_STORAGE_ACCESS_KEY || "").trim(),
    bunnyCdnBase: normalizeBunnyCdnBase(BUNNY_CDN_BASE, BUNNY_STORAGE_ENDPOINT),
  };
  const mediaCdnBase = normalizeBunnyCdnBase(BUNNY_CDN_BASE, BUNNY_STORAGE_ENDPOINT);

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
    res.type("html").send(archiveShellHtml(SITE_BASE, u, ARCHIVE_CHANNEL_IDS, labels, mediaChannelId));
  });

  app.get("/casino", requireArchiveMember, async (req, res) => {
    res.redirect(302, "/archive");
  });
  app.get("/casino/:game", requireArchiveMember, async (req, res) => {
    res.redirect(302, "/archive");
  });
  // Express 5 / path-to-regexp v8 rejects "/api/casino/*" (bare *). Match any /api/casino subpath.
  app.all(/^\/api\/casino(?:\/.*)?$/i, requireArchiveMember, async (req, res) => {
    res.status(410).json({ error: "Casino has been removed from the website." });
  });

  app.get("/api/archive/:channelId", requireArchiveMember, async (req, res) => {
    const channelId = String(req.params.channelId || "");
    if (!ARCHIVE_CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "unknown channel" });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "40", 10) || 40));
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10) || 0);

    const sanitizeIlike = (s) =>
      String(s || "")
        .slice(0, 400)
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");

    let qb = supabase.from("archive_messages").select("*", { count: "exact" }).eq("channel_id", channelId);

    const qRaw = String(req.query.q || "").trim();
    if (qRaw) qb = qb.ilike("content", `%${sanitizeIlike(qRaw)}%`);

    const authorId = String(req.query.author_id || "").trim();
    let authorLikeForRetry = "";
    if (/^\d{17,22}$/.test(authorId)) {
      qb = qb.eq("author_id", authorId);
    } else {
      const authorLike = String(req.query.author || "")
        .trim()
        .replace(/[^a-zA-Z0-9_.]/g, "")
        .slice(0, 48);
      if (authorLike) {
        const s = sanitizeIlike(authorLike);
        authorLikeForRetry = s;
        qb = qb.or(`author_display_name.ilike.%${s}%,author_tag.ilike.%${s}%,author_username.ilike.%${s}%`);
      }
    }

    const mentionUser = String(req.query.mentions || "").trim();
    if (/^\d{17,22}$/.test(mentionUser)) {
      qb = qb.contains("mention_user_ids", [mentionUser]);
    }
    const hideBots = String(req.query.hide_bots || "") === "1";
    if (hideBots) qb = qb.eq("author_is_bot", false);

    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    if (dateFrom && !Number.isNaN(Date.parse(dateFrom))) {
      qb = qb.gte("created_at_discord", new Date(dateFrom).toISOString());
    }
    if (dateTo && !Number.isNaN(Date.parse(dateTo))) {
      qb = qb.lte("created_at_discord", new Date(dateTo).toISOString());
    }

    let { data, error, count } = await qb
      .order("created_at_discord", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error && /author_display_name/i.test(String(error.message || "")) && authorLikeForRetry) {
      const legacyQb = supabase.from("archive_messages").select("*", { count: "exact" }).eq("channel_id", channelId);
      const qRaw2 = String(req.query.q || "").trim();
      if (qRaw2) legacyQb.ilike("content", `%${sanitizeIlike(qRaw2)}%`);
      if (/^\d{17,22}$/.test(authorId)) {
        legacyQb.eq("author_id", authorId);
      } else {
        legacyQb.or(`author_tag.ilike.%${authorLikeForRetry}%,author_username.ilike.%${authorLikeForRetry}%`);
      }
      const mentionUser2 = String(req.query.mentions || "").trim();
      if (/^\d{17,22}$/.test(mentionUser2)) legacyQb.contains("mention_user_ids", [mentionUser2]);
      if (hideBots) legacyQb.eq("author_is_bot", false);
      if (dateFrom && !Number.isNaN(Date.parse(dateFrom))) legacyQb.gte("created_at_discord", new Date(dateFrom).toISOString());
      if (dateTo && !Number.isNaN(Date.parse(dateTo))) legacyQb.lte("created_at_discord", new Date(dateTo).toISOString());
      ({ data, error, count } = await legacyQb
        .order("created_at_discord", { ascending: false })
        .range(offset, offset + limit - 1));
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json({
      rows: (data || []).map((r) => normalizeArchiveMessageRow(r, mediaCdnBase, mediaBackupCfg.bucket)),
      total: count ?? null,
      limit,
      offset,
    });
  });

  app.get("/api/archive/:channelId/media", requireArchiveMember, async (req, res) => {
    const channelId = String(req.params.channelId || "");
    if (!ARCHIVE_CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "unknown channel" });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "40", 10) || 40));
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10) || 0);
    const hideBots = String(req.query.hide_bots || "") === "1";

    const rows = [];
    let cursor = offset;
    let hasMore = false;
    for (let guard = 0; guard < 12 && rows.length < limit; guard++) {
      const { data, error } = await supabase
        .from("archive_messages")
        .select("*")
        .eq("channel_id", channelId)
        .order("created_at_discord", { ascending: false })
        .range(cursor, cursor + 199);
      if (error) return res.status(500).json({ error: error.message });
      const chunk = data || [];
      if (!chunk.length) break;
      for (const row of chunk) {
        if (hideBots && row.author_is_bot) continue;
        if (rowHasMedia(row)) rows.push(row);
        if (rows.length >= limit) break;
      }
      cursor += chunk.length;
      if (chunk.length < 200) break;
      hasMore = true;
    }
    res.json({
      rows: rows.slice(0, limit).map((r) => normalizeArchiveMessageRow(r, mediaCdnBase, mediaBackupCfg.bucket)),
      total: null,
      limit,
      offset,
      has_more: hasMore || rows.length >= limit,
    });
  });

  app.get("/api/archive/:channelId/:messageId", requireArchiveMember, async (req, res) => {
    const channelId = String(req.params.channelId || "");
    const messageId = String(req.params.messageId || "");
    if (!ARCHIVE_CHANNEL_IDS.includes(channelId)) return res.status(404).json({ error: "unknown channel" });
    if (!/^\d{17,22}$/.test(messageId)) return res.status(400).json({ error: "invalid message id" });
    const { data, error } = await supabase
      .from("archive_messages")
      .select("*")
      .eq("channel_id", channelId)
      .eq("message_id", messageId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "not found" });
    res.json({ row: normalizeArchiveMessageRow(data, mediaCdnBase, mediaBackupCfg.bucket) });
  });

  app.get("/archive/post/:channelId/:messageId", requireArchiveMember, async (req, res) => {
    const channelId = String(req.params.channelId || "");
    const messageId = String(req.params.messageId || "");
    if (!ARCHIVE_CHANNEL_IDS.includes(channelId)) return res.status(404).type("html").send("Unknown channel");
    if (!/^\d{17,22}$/.test(messageId)) return res.status(400).type("html").send("Invalid message ID");
    const u = req.session.archiveUser;
    const labels = CHANNEL_LABELS || {};
    const title = labels[channelId] || "#archive";
    res.type("html").send(archivePostHtml(SITE_BASE, u, channelId, messageId, title));
  });

  app.get("/profile/edit", requireArchiveMember, async (req, res) => {
    const u = req.session.archiveUser;
    const gid = String(ARCHIVE_GUILD_ID || "").trim();
    if (!gid) return res.status(500).type("html").send("Server missing ARCHIVE_GUILD_ID");
    try {
      const profile = await ensureUserBioProfile(supabase, gid, u.id, u.username);
      const stats = await archiveMessageStats(supabase, gid, u.id);
      res.type("html").send(profileEditPageHtml(SITE_BASE, u, profile, stats, null));
    } catch (e) {
      console.error("[profile/edit]", e);
      res
        .status(500)
        .type("html")
        .send(
          `<!DOCTYPE html><html><body style="font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:2rem;max-width:560px;margin:0 auto"><p>Could not load profile editor. If the database table is missing, run <code>supabase_user_bio_migrate.sql</code> in Supabase.</p><p style="color:#ed4245">${escapeHtml(String(e.message || e))}</p><p><a href="/archive" style="color:#5865f2">Back</a></p></body></html>`,
        );
    }
  });

  app.get("/api/profile/me", requireArchiveMember, async (req, res) => {
    const u = req.session.archiveUser;
    const gid = String(ARCHIVE_GUILD_ID || "").trim();
    try {
      const profile = await ensureUserBioProfile(supabase, gid, u.id, u.username);
      const stats = await archiveMessageStats(supabase, gid, u.id);
      const discordMeta = await fetchMemberProfileDiscord(bot, gid, u.id);
      res.json({ profile, stats, discord: discordMeta });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.post("/api/profile/me", requireArchiveMember, async (req, res) => {
    const u = req.session.archiveUser;
    const gid = String(ARCHIVE_GUILD_ID || "").trim();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      await ensureUserBioProfile(supabase, gid, u.id, u.username);
      const wantSlug = normalizeProfileSlug(body.slug != null ? body.slug : u.username, u.id);
      if (isReservedProfileSlug(wantSlug)) {
        return res.status(400).json({ error: "Invalid or reserved URL slug." });
      }
      const { data: taken } = await supabase.from("user_bio_profiles").select("user_id").eq("slug", wantSlug).maybeSingle();
      if (taken && String(taken.user_id) !== String(u.id)) {
        return res.status(400).json({ error: "That slug is already taken." });
      }
      const bio = String(body.bio != null ? body.bio : "").slice(0, 2000);
      const profile_display_name = String(body.profile_display_name != null ? body.profile_display_name : "")
        .trim()
        .slice(0, 80);
      const top_role_override = String(body.top_role_override != null ? body.top_role_override : "")
        .trim()
        .slice(0, 80);
      const links = sanitizeProfileLinks(body.links);
      const display_settings = mergeBioDisplaySettings(
        body.display_settings && typeof body.display_settings === "object" ? body.display_settings : {},
      );
      const upd = await supabase
        .from("user_bio_profiles")
        .update({
          slug: wantSlug,
          bio,
          links,
          profile_display_name: profile_display_name || null,
          top_role_override: top_role_override || null,
          display_settings,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", String(u.id))
        .select("*")
        .maybeSingle();
      if (upd.error) return res.status(500).json({ error: upd.error.message });
      const base = SITE_BASE.replace(/\/$/, "");
      res.json({ ok: true, profile: upd.data, public_path: `/${wantSlug}`, public_url: `${base}/${wantSlug}` });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.get("/api/profile/public/:slug", async (req, res) => {
    const slug = String(req.params.slug || "").toLowerCase();
    if (isReservedProfileSlug(slug)) return res.status(404).json({ error: "not found" });
    const { data: profile, error } = await supabase.from("user_bio_profiles").select("*").eq("slug", slug).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: "not found" });
    const gid = String(profile.guild_id || ARCHIVE_GUILD_ID || "").trim();
    const stats = await archiveMessageStats(supabase, gid, profile.user_id);
    const discordMeta = await fetchMemberProfileDiscord(bot, gid, profile.user_id);
    res.json({ profile, stats, discord: discordMeta });
  });

  app.get("/:profileSlug", async (req, res, next) => {
    const slug = String(req.params.profileSlug || "").toLowerCase();
    if (isReservedProfileSlug(slug)) return next();
    try {
      const { data: profile, error } = await supabase.from("user_bio_profiles").select("*").eq("slug", slug).maybeSingle();
      if (error) {
        if (/user_bio_profiles|schema cache/i.test(String(error.message || ""))) {
          return res.status(503).type("html").send(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#0c0d10;color:#e8eaed;padding:2rem">Bio profiles are not set up yet.</body></html>`);
        }
        return next();
      }
      if (!profile) return next();
      const gid = String(profile.guild_id || ARCHIVE_GUILD_ID || "").trim();
      const stats = await archiveMessageStats(supabase, gid, profile.user_id);
      const discordMeta = await fetchMemberProfileDiscord(bot, gid, profile.user_id);
      const viewerId = req.session?.archiveUser?.id || null;
      const base = SITE_BASE.replace(/\/$/, "");
      const profileUrl = `${base}/${slug}`;
      await logAccess(supabase, req, viewerId, `/${slug}`, "profile_view");
      res.type("html").send(
        bioProfilePageHtml(SITE_BASE, {
          slug,
          profile,
          stats,
          discordMeta,
          viewerId,
          profileUrl,
        }),
      );
    } catch (e) {
      console.error("[profile page]", e);
      next();
    }
  });

  bot.on("messageCreate", async (message) => {
    if (!message.guild) return;
    const chId = String(message.channelId);
    const firstWord = (message.content || "").trim().split(/\s+/)[0]?.toLowerCase() || "";

    if (!message.author.bot && ARCHIVE_POSTLINK_6VID_CHANNEL_IDS.has(chId) && firstWord === "6vid") {
      try {
        await replyArchive6vidCommand(message, supabase, mediaCdnBase, mediaBackupCfg.bucket, SITE_BASE, chId);
      } catch (e) {
        console.warn("[6vid]", e.message);
        await message.reply("Couldn’t load a video from the archive right now.").catch(() => {});
      }
      return;
    }

    if (!ARCHIVE_CHANNEL_IDS.includes(chId)) return;

    if (ARCHIVE_POSTLINK_6VID_CHANNEL_IDS.has(chId) && !discordMessageHasArchivableMedia(message)) {
      return;
    }

    await insertArchiveMessage(supabase, message, mediaBackupCfg);

    if (!message.author.bot && ARCHIVE_POSTLINK_6VID_CHANNEL_IDS.has(chId)) {
      try {
        const base = String(SITE_BASE || "").replace(/\/$/, "");
        const postUrl = `${base}/archive/post/${encodeURIComponent(chId)}/${encodeURIComponent(String(message.id))}`;
        await message.reply({ content: `**Archived:** ${postUrl}` });
      } catch (e) {
        console.warn("[archive] post-link reply failed:", e.message);
      }
    }
  });

  const defaultIntervalMs = Math.max(60 * 1000, NUKE_INTERVAL_MS || 24 * 60 * 60 * 1000);
  function intervalMsForChannel(channelId) {
    const map = CHANNEL_NUKE_INTERVAL_MS || {};
    const raw = parseInt(map[String(channelId)] || "", 10);
    if (Number.isFinite(raw) && raw > 0) return Math.max(60 * 1000, raw);
    return defaultIntervalMs;
  }
  const MIN_SCHEDULE_MS = 60 * 1000;

  /**
   * Reads/writes archive_nuke_schedule so restarts never purge immediately:
   * new channel → first fire in `intervalMs`; overdue → push next fire forward without purging on boot.
   */
  async function prepareDelayMs(channelId) {
    const intervalMs = intervalMsForChannel(channelId);
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
      const intervalMs = intervalMsForChannel(channelId);
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
      `[archive] ${ARCHIVE_CHANNEL_IDS.length} channel(s) scheduled (persisted in archive_nuke_schedule)`
    );
  }

  async function backfillMediaChannelHistory() {
    if (!mediaChannelId) return;
    if (!ARCHIVE_CHANNEL_IDS.includes(mediaChannelId)) return;
    const ch = await bot.channels.fetch(mediaChannelId).catch(() => null);
    if (!ch || !ch.isTextBased() || !ch.messages?.fetch) return;
    console.log(`[archive] media backfill start ${mediaChannelId}`);
    let before = undefined;
    let inserted = 0;
    for (;;) {
      const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;
      const rows = [...batch.values()];
      for (const m of rows) {
        if (!m.guild) continue;
        if (!m.attachments?.size) continue;
        if (![...m.attachments.values()].some(attachmentLooksMedia)) continue;
        await insertArchiveMessage(supabase, m, mediaBackupCfg);
        inserted += 1;
      }
      before = rows[rows.length - 1]?.id;
      if (batch.size < 100) break;
    }
    console.log(`[archive] media backfill done ${mediaChannelId} (${inserted} media messages)`);
  }

  bot.once("ready", () => {
    if (mediaBackupCfg.provider === "supabase") {
      void ensureMediaBucket(supabase, mediaBackupCfg.bucket);
    }
    scheduleNuksFromDb();
    void backfillMediaChannelHistory();
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
         <p style="margin:16px 0 0"><a class="btn" href="${escapeHtml(siteBase)}/profile/edit" style="background:#313338">Edit profile / bio link</a></p>
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

function archiveShellHtml(siteBase, user, channelIds, labels, mediaChannelId) {
  const channelsJson = JSON.stringify(channelIds);
  const labelsJson = JSON.stringify(labels);
  const mediaChannelJson = JSON.stringify(String(mediaChannelId || ""));
  const name = escapeHtml(user.global_name || user.username || "member");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Archives — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --panel:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --green:#3ba55d; }
    html, body { margin:0; height:100%; }
    body.archive-page { font-family:system-ui,sans-serif; background:var(--bg); color:var(--text);
      display:flex; flex-direction:column; min-height:100vh; max-height:100vh; overflow:hidden; }
    header { flex-shrink:0; padding:16px 20px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    header a { color:#5865f2; }
    .filters-wrap { flex-shrink:0; border-bottom:1px solid var(--border); background:#14161c; }
    .filters-toggle { width:100%; max-width:1100px; margin:0 auto; display:flex; justify-content:space-between; align-items:center;
      padding:10px 20px; background:transparent; border:none; color:var(--text); cursor:pointer; font-size:13px; }
    .filters-toggle .hint { color:var(--muted); font-size:12px; }
    .filters { display:none; padding:14px 20px;
      flex-wrap:wrap; gap:12px; align-items:flex-end; max-width:1100px; margin:0 auto; width:100%; box-sizing:border-box; }
    .filters.show { display:flex; }
    .filters .field label { font-size:11px; color:var(--muted); display:block; margin-bottom:4px; }
    .filters input[type="text"], .filters input[type="search"], .filters input[type="datetime-local"] {
      background:#1e2128; border:1px solid var(--border); color:var(--text); padding:8px 10px; border-radius:8px; font-size:13px;
      min-width:100px; max-width:220px; box-sizing:border-box; }
    .filters button { padding:9px 16px; border-radius:8px; border:none; font-weight:600; cursor:pointer; font-size:13px; }
    .filters button.primary { background:#5865f2; color:#fff; }
    .filters button.ghost { background:transparent; border:1px solid #4e5058; color:var(--text); }
    .tabs { flex-shrink:0; display:flex; gap:8px; padding:12px 20px; flex-wrap:wrap; border-bottom:1px solid var(--border); }
    .tabs button { background:#1e2128; border:1px solid var(--border); color:var(--text); padding:8px 14px; border-radius:8px; cursor:pointer; }
    .tabs button.active { border-color:var(--green); color:var(--green); }
    .mode-row { display:none; gap:8px; padding:8px 20px; border-bottom:1px solid var(--border); }
    .mode-row button { background:#1e2128; border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:8px; cursor:pointer; }
    .mode-row button.active { border-color:#5865f2; color:#c7d2fe; }
    #stats { flex-shrink:0; padding:8px 20px; font-size:12px; color:var(--muted); max-width:900px; margin:0 auto; width:100%; box-sizing:border-box; }
    #feed-scroll { flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; width:100%; }
    #feed { padding:12px 20px 80px; max-width:900px; margin:0 auto; box-sizing:border-box; }
    .msg { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
    .reply-context { display:flex; gap:10px; margin:0 0 10px 0; align-items:stretch; cursor:pointer; border-radius:6px; padding:4px 4px 4px 2px; margin-left:-2px; }
    .reply-context:hover { background:rgba(255,255,255,0.04); }
    .reply-bar { width:3px; min-height:2.2em; background:#4e5058; border-radius:2px; flex-shrink:0; }
    .reply-inner { min-width:0; font-size:12px; color:var(--muted); line-height:1.35; }
    .reply-inner .reply-label { color:#949ba4; }
    .reply-inner strong { color:#c9ccd1; font-weight:600; font-size:13px; }
    .reply-snippet { margin-top:4px; color:#b5bac1; white-space:pre-wrap; word-break:break-word; max-height:3.8em; overflow:hidden; }
    .msg-head { display:flex; align-items:flex-start; gap:10px; margin-bottom:6px; }
    .msg-head img.av { width:40px; height:40px; border-radius:50%; object-fit:cover; background:#1e2128; flex-shrink:0; }
    .meta { font-size:12px; color:var(--muted); line-height:1.35; }
    .meta strong { color:var(--text); font-size:15px; font-weight:600; }
    .meta .at-username { color:#949ba4; font-size:13px; font-weight:500; }
    .role-row { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; align-items:center; }
    .role-pill { font-size:11px; font-weight:600; padding:2px 8px; border-radius:4px; border:1px solid; max-width:180px;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3; }
    .role-toggle { background:transparent; border:1px solid #4e5058; color:var(--muted); border-radius:999px; font-size:11px;
      padding:2px 8px; cursor:pointer; line-height:1.3; }
    .role-toggle:hover { color:var(--text); border-color:#646872; }
    .content { white-space:pre-wrap; word-break:break-word; font-size:14px; margin-top:6px; line-height:1.45; }
    .mention { background:rgba(88,101,242,0.35); padding:1px 4px; border-radius:4px; }
    .att { margin-top:10px; }
    .att img, .att video { max-width:100%; border-radius:8px; vertical-align:middle; }
    .embeds-preview { margin-top:8px; font-size:12px; color:var(--muted); border-left:3px solid #5865f2; padding-left:10px; }
    .loading, #sentinel-msg { color:var(--muted); padding:12px; text-align:center; font-size:13px; }
    .loading.done { opacity:0.75; }
  </style>
</head>
<body class="archive-page">
  <header>
    <span>Signed in as <strong>${name}</strong></span>
    <span><a href="/profile/edit">Profile</a> · <a href="/">Home</a> · <a href="/auth/logout">Log out</a></span>
  </header>
  <div class="filters-wrap">
    <button type="button" class="filters-toggle" id="filters-toggle">
      <span>Search and filters</span><span class="hint" id="filters-toggle-label">Show</span>
    </button>
  <div class="filters" id="filters">
    <div class="field"><label for="f-q">Contains</label><input type="search" id="f-q" placeholder="Search message text…" /></div>
    <div class="field"><label for="f-author-id">From user ID</label><input type="text" id="f-author-id" placeholder="Snowflake" inputmode="numeric" /></div>
    <div class="field"><label for="f-author">Display/username contains</label><input type="text" id="f-author" placeholder="e.g. raindear" /></div>
    <div class="field"><label for="f-from">After</label><input type="datetime-local" id="f-from" /></div>
    <div class="field"><label for="f-to">Before</label><input type="datetime-local" id="f-to" /></div>
    <div class="field"><label for="f-mentions">Mentions user ID</label><input type="text" id="f-mentions" placeholder="Who was @'d" /></div>
    <div class="field"><label for="f-hide-bots">Bot messages</label><input type="checkbox" id="f-hide-bots" checked /> Hide bot messages</div>
    <button type="button" class="primary" id="f-apply">Apply filters</button>
    <button type="button" class="ghost" id="f-clear">Clear</button>
  </div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="mode-row" id="mode-row">
    <button type="button" id="mode-messages" class="active">Chats</button>
    <button type="button" id="mode-media">Media</button>
  </div>
  <div id="stats"></div>
  <div id="feed-scroll">
    <div id="feed"><p class="loading">Loading…</p></div>
    <div id="sentinel-msg" style="display:none"></div>
    <div id="sentinel" style="height:1px"></div>
  </div>
  <script>
    const CHANNEL_IDS = ${channelsJson};
    const LABELS = ${labelsJson};
    const MEDIA_CHANNEL_ID = ${mediaChannelJson};
    const PAGE = 40;
    let active = CHANNEL_IDS[0] || "";
    let viewMode = "messages";
    let offset = 0;
    let loading = false;
    let exhausted = false;
    let totalKnown = null;
    let io = null;

    const tabs = document.getElementById("tabs");
    const filters = document.getElementById("filters");
    const filtersToggleLabel = document.getElementById("filters-toggle-label");
    const modeRow = document.getElementById("mode-row");
    const feed = document.getElementById("feed");
    const stats = document.getElementById("stats");
    const sentinel = document.getElementById("sentinel");
    const sentinelMsg = document.getElementById("sentinel-msg");
    CHANNEL_IDS.forEach((id) => {
      const b = document.createElement("button");
      b.textContent = LABELS[id] || ("#" + id.slice(-6));
      b.dataset.id = id;
      if (id === active) b.classList.add("active");
      b.onclick = () => {
        active = id;
        // Always default to chat view when selecting a channel tab.
        // Blood channel still has a separate Media tab, but it won't open media-only by default.
        viewMode = "messages";
        [...tabs.querySelectorAll("button")].forEach((x) => x.classList.toggle("active", x.dataset.id === active));
        syncModeButtons();
        resetAndLoad();
      };
      tabs.appendChild(b);
    });

    function syncModeButtons() {
      var isMediaChannel = active === MEDIA_CHANNEL_ID;
      modeRow.style.display = isMediaChannel ? "flex" : "none";
      document.getElementById("mode-messages").classList.toggle("active", viewMode === "messages");
      document.getElementById("mode-media").classList.toggle("active", viewMode === "media");
    }

    function queryParams() {
      const p = new URLSearchParams();
      p.set("limit", String(PAGE));
      p.set("offset", String(offset));
      var q = document.getElementById("f-q").value.trim();
      var aid = document.getElementById("f-author-id").value.trim();
      var an = document.getElementById("f-author").value.trim();
      var df = document.getElementById("f-from").value;
      var dt = document.getElementById("f-to").value;
      var ment = document.getElementById("f-mentions").value.trim();
      var hideBots = document.getElementById("f-hide-bots").checked;
      if (q) p.set("q", q);
      if (aid) p.set("author_id", aid);
      if (an) p.set("author", an);
      if (df) p.set("date_from", new Date(df).toISOString());
      if (dt) p.set("date_to", new Date(dt).toISOString());
      if (ment) p.set("mentions", ment);
      if (hideBots) p.set("hide_bots", "1");
      return p;
    }

    function setFiltersExpanded(expanded) {
      filters.classList.toggle("show", expanded);
      filtersToggleLabel.textContent = expanded ? "Hide" : "Show";
    }

    function resetAndLoad() {
      offset = 0;
      exhausted = false;
      totalKnown = null;
      feed.innerHTML = '<p class="loading">Loading…</p>';
      sentinelMsg.style.display = "none";
      loadPage(true);
    }

    async function loadPage(isFirst) {
      if (loading || exhausted) return;
      loading = true;
      try {
        const suffix = viewMode === "media" ? "/media" : "";
        const base = "/api/archive/" + active + suffix + "?" + queryParams().toString();
        const r = await fetch(base);
        if (!r.ok) {
          feed.innerHTML = '<p class="loading">Failed to load.</p>';
          loading = false;
          return;
        }
        const j = await r.json();
        if (typeof j.total === "number") totalKnown = j.total;
        var rows = j.rows || [];

        if (isFirst) {
          feed.innerHTML = "";
          if (!rows.length) {
            feed.innerHTML = '<p class="loading">No messages match (or nothing logged yet).</p>';
            exhausted = true;
            updateStats(0);
            loading = false;
            return;
          }
        }

        if (!isFirst && !rows.length) {
          exhausted = true;
          updateStats(feed.querySelectorAll(".msg").length);
          sentinelMsg.textContent =
            totalKnown != null ? "End of archive · " + totalKnown + " messages matched" : "End of archive";
          sentinelMsg.style.display = "block";
          return;
        }

        for (var i = 0; i < rows.length; i++) {
          feed.appendChild(viewMode === "media" ? renderMediaCard(rows[i]) : renderMessage(rows[i]));
        }

        offset += rows.length;
        if (rows.length < PAGE) exhausted = true;

        updateStats(feed.querySelectorAll(".msg").length);
        if (exhausted) {
          sentinelMsg.textContent = totalKnown != null
            ? "End of archive · " + totalKnown + " messages matched"
            : "End of archive";
          sentinelMsg.style.display = "block";
          sentinelMsg.classList.add("done");
        }
      } finally {
        loading = false;
      }
    }

    function updateStats(loadedCount) {
      if (totalKnown != null) {
        var noun = viewMode === "media" ? "media posts" : "messages";
        stats.textContent = "Showing " + loadedCount + " of " + totalKnown + " " + noun + " (scroll down for more)";
      } else {
        var noun2 = viewMode === "media" ? "media posts" : "messages";
        stats.textContent = loadedCount ? ("Loaded " + loadedCount + " " + noun2 + " — scroll for more") : "";
      }
    }

    function normalizeAuthorRoles(raw) {
      if (raw == null) return [];
      if (typeof raw === "string") {
        var s = raw.trim();
        if (!s || s === "null") return [];
        try {
          return normalizeAuthorRoles(JSON.parse(s));
        } catch (e0) {
          return [];
        }
      }
      if (!Array.isArray(raw)) {
        if (typeof raw === "object" && raw && raw.id != null) return [normalizeRoleObject(raw)];
        return [];
      }
      var out = [];
      for (var j = 0; j < raw.length; j++) out.push(normalizeRoleObject(raw[j]));
      return out;
    }
    function normalizeRoleObject(r) {
      if (!r || typeof r !== "object") return { id: "", name: "", position: 0, color: 0, hexColor: null };
      var c = r.color;
      if (typeof c === "string") {
        var cs = c.trim();
        c = /^-?\\d+$/.test(cs) ? parseInt(cs, 10) : 0;
      } else if (typeof c !== "number" || !Number.isFinite(c)) {
        c = 0;
      }
      var pos = r.position;
      if (typeof pos === "string") {
        var ps = pos.trim();
        pos = /^-?\\d+$/.test(ps) ? parseInt(ps, 10) : 0;
      } else if (typeof pos !== "number" || !Number.isFinite(pos)) {
        pos = 0;
      }
      var hx = r.hexColor || r.hex_color || null;
      if (typeof hx !== "string" || hx === "#000000") hx = null;
      return {
        id: String(r.id != null ? r.id : ""),
        name: String(r.name != null ? r.name : "").slice(0, 80),
        position: pos,
        color: c,
        hexColor: hx,
      };
    }

    function sortRolesByPositionDesc(roles) {
      if (!Array.isArray(roles) || !roles.length) return [];
      var a = [];
      for (var si = 0; si < roles.length; si++) a.push(normalizeRoleObject(roles[si]));
      a.sort(function (x, y) {
        return (y.position || 0) - (x.position || 0);
      });
      return a;
    }

    function roleHasDyeColor(ro) {
      var o = normalizeRoleObject(ro);
      if (o.hexColor && o.hexColor !== "#000000") return true;
      return typeof o.color === "number" && o.color !== 0;
    }

    /** Discord-style name color: highest-position role that actually carries a color (no luminance clamp — matches client). */
    function roleColorTextForDisplayName(ro) {
      var o = normalizeRoleObject(ro);
      var hex = o.hexColor;
      if (hex && hex !== "#000000") return hex;
      var c = o.color;
      if (!c) return "";
      var R = (c >> 16) & 255,
        G = (c >> 8) & 255,
        B = c & 255;
      return "rgb(" + R + "," + G + "," + B + ")";
    }
    function formatAuthorDisplayParts(row) {
      var dn = String(row.author_display_name || "").trim();
      var un = String(row.author_username || "").trim();
      var tag = String(row.author_tag || "").trim();
      if (!dn && tag) {
        var hash = tag.indexOf("#");
        dn = hash > 0 ? tag.slice(0, hash) : tag;
      }
      if (!dn) dn = un || String(row.author_id || "");
      var showAt = un && un !== dn;
      return { display: dn, username: un, showAt: showAt };
    }
    function authorNameHtml(row, nameStyle) {
      var p = formatAuthorDisplayParts(row);
      var at = p.showAt ? '<span class="at-username">@' + escapeHtml(p.username) + "</span>" : "";
      return '<strong style="' + nameStyle + '">' + escapeHtml(p.display) + "</strong>" + at;
    }

    function renderMediaCard(row) {
      var div = document.createElement("div");
      div.className = "msg";
      var when = row.created_at_discord ? new Date(row.created_at_discord).toLocaleString() : "";
      var nameStyle = displayNameStyle(normalizeAuthorRoles(row.author_roles));
      var body = renderAttachments(row.attachments);
      if (!body) body = '<div class="content">' + formatContent(row.content || "") + "</div>";
      var sitePost =
        "/archive/post/" + encodeURIComponent(String(row.channel_id || "")) + "/" + encodeURIComponent(String(row.message_id || ""));
      div.innerHTML =
        '<div class="meta">' + authorNameHtml(row, nameStyle) + " · " + escapeHtml(when) + "</div>" +
        '<div class="att" style="margin-top:8px"><a href="https://discord.com/channels/' +
        escapeHtml(String(row.guild_id || "")) + "/" +
        escapeHtml(String(row.channel_id || "")) + "/" +
        escapeHtml(String(row.message_id || "")) +
        '" target="_blank" rel="noopener noreferrer">Open original Discord message</a> · ' +
        '<a href="' + escapeHtml(sitePost) + '" target="_blank" rel="noopener noreferrer">Open archive post page</a></div>' +
        body;
      return div;
    }

    function renderReply(row) {
      if (!row.reply_to_message_id) return "";
      var who =
        row.reply_to_author_tag || row.reply_to_author_id
          ? "<strong>" + escapeHtml(String(row.reply_to_author_tag || row.reply_to_author_id)) + "</strong>"
          : "<strong>Unknown</strong>";
      var snip = row.reply_to_content
        ? '<div class="reply-snippet">' + formatContent(row.reply_to_content) + "</div>"
        : "";
      var mid = escapeHtml(String(row.reply_to_message_id));
      return (
        '<div class="reply-context" data-jump-to="' +
        mid +
        '" title="Jump to parent message if it is loaded below">' +
        '<span class="reply-bar" aria-hidden="true"></span>' +
        '<div class="reply-inner"><span class="reply-label">Replying to </span>' +
        who +
        snip +
        "</div></div>"
      );
    }

    function renderMessage(row) {
      var div = document.createElement("div");
      div.className = "msg";
      if (row.message_id) div.dataset.mid = String(row.message_id);
      var when = row.created_at_discord ? new Date(row.created_at_discord).toLocaleString() : "";
      var rolesArr = normalizeAuthorRoles(row.author_roles);
      var nameStyle = displayNameStyle(rolesArr);
      div.innerHTML =
        renderReply(row) +
        '<div class="msg-head">' +
          '<img class="av" src="' + escapeHtml(avatarUrl(row)) + '" width="40" height="40" alt="" />' +
          '<div style="min-width:0;flex:1">' +
            '<div class="meta">' + authorNameHtml(row, nameStyle) + " · " + escapeHtml(when) + "</div>" +
            renderRoles(rolesArr) +
          "</div>" +
        "</div>" +
        '<div class="content">' + formatContent(row.content || "") + "</div>" +
        renderAttachments(row.attachments) +
        renderStickers(row.stickers) +
        renderEmbeds(row.embeds);
      return div;
    }

    function renderRoles(roles) {
      if (!Array.isArray(roles) || !roles.length) return "";
      var PREVIEW = 1;
      var sorted = sortRolesByPositionDesc(roles);
      var previewRoles = sorted.slice(0, PREVIEW);
      var out = '<div class="role-row">';
      for (var i = 0; i < previewRoles.length; i++) {
        var r = previewRoles[i];
        var st = rolePillStyle(r);
        out += '<span class="role-pill" style="' + st + '">' + escapeHtml(r.name || "") + "</span>";
      }
      if (sorted.length > PREVIEW) {
        out +=
          '<button type="button" class="role-toggle" data-state="collapsed" data-preview="' +
          String(PREVIEW) +
          '" data-roles="' +
          encodeRolesData(sorted) +
          '">View all (' +
          String(sorted.length) +
          ")</button>";
      }
      out += "</div>";
      return out;
    }

    function displayNameStyle(roles) {
      if (!Array.isArray(roles) || !roles.length) return "color:#e8eaed";
      var sorted = sortRolesByPositionDesc(roles);
      for (var i = 0; i < sorted.length; i++) {
        if (!roleHasDyeColor(sorted[i])) continue;
        var color = roleColorTextForDisplayName(sorted[i]);
        if (color) return "color:" + color;
      }
      return "color:#e8eaed";
    }

    function rolePillStyle(r) {
      var ro = normalizeRoleObject(r);
      var color = roleColorText(ro);
      if (!color) return "border-color:#5c6370;color:#b9bbbe;background:rgba(0,0,0,0.22)";
      return "border-color:" + color + ";color:" + color + ";background:rgba(0,0,0,0.28)";
    }

    function _roleLinRGB(R, G, B) {
      function lin(x) {
        x /= 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      }
      var r = lin(R),
        g = lin(G),
        b = lin(B);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function _roleRelLumHex(hex) {
      var s = String(hex || "").trim();
      var m3 = /^#([0-9a-f]{3})$/i.exec(s);
      if (m3) {
        var t = m3[1];
        return _roleLinRGB(
          parseInt(t[0] + t[0], 16),
          parseInt(t[1] + t[1], 16),
          parseInt(t[2] + t[2], 16),
        );
      }
      var m6 = /^#([0-9a-f]{6})$/i.exec(s);
      if (!m6) return 1;
      var n = parseInt(m6[1], 16);
      return _roleLinRGB((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }

    /** Skip near-black / very dark role colors on dark archive UI (name + pills fall back to readable neutrals). */
    function _roleTooDarkForArchiveUI(css) {
      if (!css) return true;
      if (/^#/i.test(String(css))) return _roleRelLumHex(css) < 0.22;
      var s = String(css).trim().toLowerCase();
      if (!s.startsWith("rgb(")) return false;
      var inner = s.slice(4, s.lastIndexOf(")"));
      var parts = inner.split(",");
      if (parts.length !== 3) return false;
      var R = parseInt(parts[0], 10),
        G = parseInt(parts[1], 10),
        B = parseInt(parts[2], 10);
      if (!Number.isFinite(R) || !Number.isFinite(G) || !Number.isFinite(B)) return false;
      return _roleLinRGB(R, G, B) < 0.22;
    }

    function roleColorText(r) {
      var ro = normalizeRoleObject(r);
      var hex = ro.hexColor;
      if (hex && hex !== "#000000" && !_roleTooDarkForArchiveUI(hex)) return hex;
      var c = ro.color;
      if (!c) return "";
      var R = (c >> 16) & 255,
        G = (c >> 8) & 255,
        B = c & 255;
      var rgb = "rgb(" + R + "," + G + "," + B + ")";
      if (_roleTooDarkForArchiveUI(rgb)) return "";
      return rgb;
    }

    function encodeRolesData(roles) {
      try {
        return encodeURIComponent(JSON.stringify(roles));
      } catch {
        return "";
      }
    }

    function decodeRolesData(s) {
      try {
        var parsed = JSON.parse(decodeURIComponent(String(s || "")));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function renderRolePills(roles) {
      var html = "";
      for (var i = 0; i < roles.length; i++) {
        var r = roles[i];
        html += '<span class="role-pill" style="' + rolePillStyle(r) + '">' + escapeHtml(r.name || "") + "</span>";
      }
      return html;
    }

    function formatContent(text) {
      var t = escapeHtml(text || "");
      return t.replace(/&lt;@!?([0-9]{5,22})&gt;/g, '<span class="mention">&lt;@$1&gt;</span>');
    }

    function avatarUrl(row) {
      var id = String(row.author_id || "");
      var h = row.author_avatar_hash;
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
        var urls = uniqueMediaUrls(a);
        var url = urls[0] || "";
        var alt = encodeAltUrls(urls.slice(1));
        var ct = String(a.contentType || a.content_type || "").toLowerCase();
        var name = a.name || "attachment";
        if (!url) continue;
        if (ct.indexOf("image/") === 0) {
          html +=
            '<div class="att"><img src="' +
            escapeHtml(url) +
            '" alt="" loading="lazy" data-alt-urls="' +
            escapeHtml(alt) +
            '" data-fallback-idx="0" onerror="archiveMediaFallback(this)" /></div>';
        } else if (ct.indexOf("video/") === 0) {
          html +=
            '<div class="att"><video controls preload="metadata" src="' +
            escapeHtml(url) +
            '" data-alt-urls="' +
            escapeHtml(alt) +
            '" data-fallback-idx="0" onerror="archiveMediaFallback(this)"></video></div>';
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

    function uniqueMediaUrls(a) {
      var cands = [a?.mirroredUrl, a?.mirrored_url, a?.proxyUrl, a?.proxy_url, a?.url];
      var out = [];
      for (var i = 0; i < cands.length; i++) {
        var u = String(cands[i] || "").trim();
        if (!u || out.indexOf(u) !== -1) continue;
        out.push(u);
      }
      return out;
    }

    function encodeAltUrls(arr) {
      try {
        return encodeURIComponent(JSON.stringify(arr || []));
      } catch {
        return "";
      }
    }

    function decodeAltUrls(s) {
      try {
        var parsed = JSON.parse(decodeURIComponent(String(s || "")));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function archiveMediaFallback(el) {
      var list = decodeAltUrls(el.dataset.altUrls || "");
      var idx = parseInt(el.dataset.fallbackIdx || "0", 10) || 0;
      if (!list.length || idx >= list.length) return;
      var next = String(list[idx] || "");
      el.dataset.fallbackIdx = String(idx + 1);
      if (!next) return;
      el.src = next;
      if (typeof el.load === "function") el.load();
    }
    window.archiveMediaFallback = archiveMediaFallback;

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

    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s == null ? "" : s;
      return d.innerHTML;
    }

    function setupObserver() {
      if (io) io.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
              loadPage(false);
            }
          }
        },
        { root: document.getElementById("feed-scroll"), rootMargin: "120px", threshold: 0 }
      );
      io.observe(sentinel);
    }

    document.getElementById("feed-scroll").addEventListener("click", function (ev) {
      var ctx = ev.target.closest(".reply-context");
      if (ctx && ctx.dataset.jumpTo) {
        var id = String(ctx.dataset.jumpTo || "");
        if (/^\d{5,22}$/.test(id)) {
          var target = feed.querySelector('.msg[data-mid="' + id + '"]');
          if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }

      var rt = ev.target.closest(".role-toggle");
      if (!rt) return;
      var allRoles = decodeRolesData(rt.dataset.roles);
      if (!allRoles.length) return;
      var previewCount = Math.max(1, parseInt(rt.dataset.preview || "1", 10) || 1);
      var expanded = rt.dataset.state === "expanded";
      var row = rt.closest(".role-row");
      if (!row) return;

      if (expanded) {
        row.innerHTML =
          renderRolePills(allRoles.slice(0, previewCount)) +
          '<button type="button" class="role-toggle" data-state="collapsed" data-preview="' +
          String(previewCount) +
          '" data-roles="' +
          encodeRolesData(allRoles) +
          '">View all (' +
          String(allRoles.length) +
          ")</button>";
      } else {
        row.innerHTML =
          renderRolePills(allRoles) +
          '<button type="button" class="role-toggle" data-state="expanded" data-preview="' +
          String(previewCount) +
          '" data-roles="' +
          encodeRolesData(allRoles) +
          '">Collapse</button>';
      }
    });

    document.getElementById("f-apply").onclick = resetAndLoad;
    document.getElementById("f-clear").onclick = () => {
      document.getElementById("f-q").value = "";
      document.getElementById("f-author-id").value = "";
      document.getElementById("f-author").value = "";
      document.getElementById("f-from").value = "";
      document.getElementById("f-to").value = "";
      document.getElementById("f-mentions").value = "";
      document.getElementById("f-hide-bots").checked = true;
      resetAndLoad();
    };
    document.getElementById("filters-toggle").onclick = function () {
      setFiltersExpanded(!filters.classList.contains("show"));
    };
    document.getElementById("mode-messages").onclick = function () {
      viewMode = "messages";
      syncModeButtons();
      resetAndLoad();
    };
    document.getElementById("mode-media").onclick = function () {
      viewMode = "media";
      syncModeButtons();
      resetAndLoad();
    };

    setFiltersExpanded(false);
    syncModeButtons();
    resetAndLoad();
    setupObserver();
  </script>
</body>
</html>`;
}

function archivePostHtml(siteBase, user, channelId, messageId, channelTitle) {
  const name = escapeHtml(user.global_name || user.username || "member");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(channelTitle)} post — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --panel:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; }
    .wrap { max-width:980px; margin:0 auto; padding:20px; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
    a { color:#8ea1ff; }
    .card { border:1px solid var(--border); background:var(--panel); border-radius:12px; padding:14px; }
    .meta { color:var(--muted); font-size:13px; margin-bottom:8px; }
    .content { white-space:pre-wrap; word-break:break-word; line-height:1.45; }
    .att { margin-top:10px; }
    .att img, .att video { max-width:100%; border-radius:8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>Signed in as <strong>${name}</strong></div>
      <div><a href="/archive">Back to archives</a></div>
    </div>
    <div class="card" id="post"><div class="meta">Loading post…</div></div>
  </div>
  <script>
    const channelId = ${JSON.stringify(String(channelId || ""))};
    const messageId = ${JSON.stringify(String(messageId || ""))};

    function esc(s) {
      var d = document.createElement("div");
      d.textContent = s == null ? "" : s;
      return d.innerHTML;
    }
    function format(t) {
      return esc(t || "").replace(/&lt;@!?([0-9]{5,22})&gt;/g, '<span style="background:rgba(88,101,242,.35);padding:1px 4px;border-radius:4px">&lt;@$1&gt;</span>');
    }
    function renderAtt(att) {
      if (!Array.isArray(att) || !att.length) return "";
      var html = "";
      for (var i = 0; i < att.length; i++) {
        var a = att[i] || {};
        var urls = uniqueUrls(a);
        var url = urls[0] || "";
        var alt = encodeAlt(urls.slice(1));
        var ct = String(a.contentType || a.content_type || "").toLowerCase();
        var name = a.name || "attachment";
        if (!url) continue;
        if (ct.indexOf("image/") === 0) {
          html +=
            '<div class="att"><img src="' +
            esc(url) +
            '" alt="" loading="lazy" data-alt-urls="' +
            esc(alt) +
            '" data-fallback-idx="0" onerror="postMediaFallback(this)" /></div>';
        } else if (ct.indexOf("video/") === 0) {
          html +=
            '<div class="att"><video controls preload="metadata" src="' +
            esc(url) +
            '" data-alt-urls="' +
            esc(alt) +
            '" data-fallback-idx="0" onerror="postMediaFallback(this)"></video></div>';
        }
        else html += '<div class="att"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + "</a></div>";
      }
      return html;
    }

    function uniqueUrls(a) {
      var cands = [a?.mirroredUrl, a?.mirrored_url, a?.proxyUrl, a?.proxy_url, a?.url];
      var out = [];
      for (var i = 0; i < cands.length; i++) {
        var u = String(cands[i] || "").trim();
        if (!u || out.indexOf(u) !== -1) continue;
        out.push(u);
      }
      return out;
    }
    function encodeAlt(arr) {
      try { return encodeURIComponent(JSON.stringify(arr || [])); } catch { return ""; }
    }
    function decodeAlt(s) {
      try {
        var parsed = JSON.parse(decodeURIComponent(String(s || "")));
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    function postMediaFallback(el) {
      var list = decodeAlt(el.dataset.altUrls || "");
      var idx = parseInt(el.dataset.fallbackIdx || "0", 10) || 0;
      if (!list.length || idx >= list.length) return;
      var next = String(list[idx] || "");
      el.dataset.fallbackIdx = String(idx + 1);
      if (!next) return;
      el.src = next;
      if (typeof el.load === "function") el.load();
    }
    window.postMediaFallback = postMediaFallback;

    fetch("/api/archive/" + encodeURIComponent(channelId) + "/" + encodeURIComponent(messageId))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) {
        var row = j.row || {};
        var when = row.created_at_discord ? new Date(row.created_at_discord).toLocaleString() : "";
        var dn = String(row.author_display_name || "").trim();
        var un = String(row.author_username || "").trim();
        var tag = String(row.author_tag || "").trim();
        if (!dn && tag) {
          var h = tag.indexOf("#");
          dn = h > 0 ? tag.slice(0, h) : tag;
        }
        if (!dn) dn = un || String(row.author_id || "unknown");
        var at = un && un !== dn ? ' <span style="color:#949ba4;font-size:13px;font-weight:500">@' + esc(un) + "</span>" : "";
        var post = document.getElementById("post");
        post.innerHTML =
          '<div class="meta"><strong>' + esc(dn) + "</strong>" + at + " · " + esc(when) + "</div>" +
          '<div><a href="https://discord.com/channels/' + esc(String(row.guild_id || "")) + "/" + esc(String(row.channel_id || "")) + "/" + esc(String(row.message_id || "")) + '" target="_blank" rel="noopener noreferrer">Open original Discord message</a></div>' +
          '<div class="content" style="margin-top:10px">' + format(row.content || "") + "</div>" +
          renderAtt(row.attachments);
      })
      .catch(function () {
        document.getElementById("post").innerHTML = '<div class="meta">Post not found.</div>';
      });
  </script>
</body>
</html>`;
}

function casinoGameHtml(siteBase, user, wallet, game) {
  const name = escapeHtml(user.global_name || user.username || "member");
  const current = ["blackjack", "crash", "mines"].includes(game) ? game : "blackjack";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Casino — 6xs</title>
  <style>
    :root { --bg:#0c0d10; --panel:#14161c; --border:#252830; --text:#e8eaed; --muted:#9aa0a6; --accent:#5865f2; --good:#3ba55d; --bad:#ed4245; }
    * { box-sizing:border-box; } body { margin:0; font-family:system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:14px 18px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; }
    header a { color:#8ea1ff; } .wrap { max-width:900px; margin:0 auto; padding:16px; }
    .bal { color:#d3f9d8; } .nav { display:flex; gap:8px; margin-bottom:12px; }
    .nav a { padding:8px 12px; border-radius:8px; border:1px solid var(--border); text-decoration:none; color:var(--text); background:#1b1e24; }
    .nav a.active { border-color:var(--accent); color:#c7d2fe; }
    .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px; }
    h2 { margin:0 0 8px; font-size:1.05rem; } p { margin:6px 0; color:var(--muted); font-size:13px; }
    label { display:block; font-size:12px; color:#b8bcc6; margin:8px 0 4px; } input { width:100%; background:#1d2027; border:1px solid var(--border); color:var(--text); border-radius:8px; padding:8px; }
    button { margin-top:10px; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 12px; cursor:pointer; font-weight:600; }
    .row { display:flex; gap:8px; } .row > * { flex:1; } .out { margin-top:8px; font-size:13px; white-space:pre-wrap; }
    .ok { color:var(--good); } .err { color:var(--bad); }
    .viz { margin-top:10px; border:1px solid var(--border); border-radius:10px; background:#0f1217; padding:12px; min-height:120px; }
    .crash-meter { font-size:28px; font-weight:700; letter-spacing:0.02em; }
    .crash-bar { height:10px; background:#1d2230; border-radius:999px; overflow:hidden; margin-top:8px; }
    .crash-fill { height:100%; width:0%; background:linear-gradient(90deg,#5865f2,#7c9cff); transition:width .12s linear; }
    .mines-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
    .tile { border:1px solid var(--border); border-radius:8px; height:36px; display:flex; align-items:center; justify-content:center; background:#1a1f2a; font-size:12px; color:#aab0bc; }
    .tile.safe { background:#1f3a2a; color:#d1fadf; border-color:#2f6e4c; }
  </style>
</head>
<body>
  <header>
    <span>Signed in as <strong>${name}</strong></span>
    <span><a href="/">Home</a> · <a href="/archive">Archive</a> · <span class="bal" id="bal">Balance: ${Number(wallet || 0).toLocaleString()} coins</span> · <a href="/auth/logout">Log out</a></span>
  </header>
  <div class="wrap">
    <div class="nav">
      <a href="/casino/blackjack" class="${current === "blackjack" ? "active" : ""}">Blackjack</a>
      <a href="/casino/crash" class="${current === "crash" ? "active" : ""}">Crash</a>
      <a href="/casino/mines" class="${current === "mines" ? "active" : ""}">Mines</a>
    </div>
    <div class="card">
      ${current === "blackjack" ? `
      <h2>Blackjack</h2>
      <p>Start a hand, then hit or stand.</p>
      <label>Bet</label><input id="bj-bet" type="number" min="1" value="100" />
      <div class="row"><button id="bj-start">Start</button><button id="bj-hit">Hit</button><button id="bj-stand">Stand</button></div>
      <div class="viz" id="bj-viz">No active hand.</div>
      <div class="out" id="bj-out"></div>` : ""}
      ${current === "crash" ? `
      <h2>Crash</h2>
      <p>Set auto cashout multiplier. Win if crash point reaches it.</p>
      <label>Bet</label><input id="cr-bet" type="number" min="1" value="100" />
      <label>Cashout multiplier</label><input id="cr-mult" type="number" min="1.01" step="0.01" value="1.8" />
      <button id="cr-play">Play Crash</button>
      <div class="viz"><div class="crash-meter" id="cr-meter">x1.00</div><div class="crash-bar"><div class="crash-fill" id="cr-fill"></div></div></div>
      <div class="out" id="cr-out"></div>` : ""}
      ${current === "mines" ? `
      <h2>Mines</h2>
      <p>Start a board, click tiles, then cash out anytime before a mine.</p>
      <label>Bet</label><input id="mi-bet" type="number" min="1" value="100" />
      <div class="row"><div><label>Tiles</label><input id="mi-tiles" type="number" min="5" max="25" value="25" /></div><div><label>Mines</label><input id="mi-mines" type="number" min="1" max="24" value="3" /></div></div>
      <div class="row"><button id="mi-start">Start game</button><button id="mi-cashout">Cash out</button></div>
      <div class="viz"><div class="mines-grid" id="mi-grid"></div></div>
      <div class="out" id="mi-out"></div>` : ""}
    </div>
  </div>
  <script>
    function fmt(n) { return Number(n || 0).toLocaleString(); }
    function setBal(n) { document.getElementById("bal").textContent = "Balance: " + fmt(n) + " coins"; }
    function refreshBalance() {
      fetch("/api/casino/balance", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) setBal(j.wallet); })
        .catch(function () {});
    }
    refreshBalance();
    setInterval(refreshBalance, 7000);
    async function post(url, body) {
      const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Request failed");
      return j;
    }
    const game = ${JSON.stringify(current)};
    if (game === "blackjack") {
      document.getElementById("bj-start").onclick = async function () {
        const out = document.getElementById("bj-out"), viz = document.getElementById("bj-viz");
        try {
          const j = await post("/api/casino/blackjack/start", { bet: Number(document.getElementById("bj-bet").value || 0) });
          setBal(j.wallet); out.className = "out";
          if (j.done) {
            out.textContent = "Result: " + j.result + "\\nPayout: " + fmt(j.payout);
            viz.textContent = "Player: " + (j.player||[]).join(" ") + " (" + j.playerTotal + ") | Dealer: " + (j.dealer||[]).join(" ") + " (" + j.dealerTotal + ")";
          } else {
            out.textContent = "Hand started.";
            viz.textContent = "Player: " + (j.player||[]).join(" ") + " (" + j.playerTotal + ") | Dealer up: " + (j.dealerUp||[]).join(" ");
          }
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
      document.getElementById("bj-hit").onclick = async function () {
        const out = document.getElementById("bj-out"), viz = document.getElementById("bj-viz");
        try {
          const j = await post("/api/casino/blackjack/hit", {});
          setBal(j.wallet); out.className = "out";
          out.textContent = j.done ? ("Result: " + j.result) : "Hit.";
          viz.textContent = j.done
            ? ("Player: " + (j.player||[]).join(" ") + " (" + j.playerTotal + ") | Dealer: " + (j.dealer||[]).join(" ") + " (" + j.dealerTotal + ")")
            : ("Player: " + (j.player||[]).join(" ") + " (" + j.playerTotal + ") | Dealer up: " + (j.dealerUp||[]).join(" "));
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
      document.getElementById("bj-stand").onclick = async function () {
        const out = document.getElementById("bj-out"), viz = document.getElementById("bj-viz");
        try {
          const j = await post("/api/casino/blackjack/stand", {});
          setBal(j.wallet); out.className = "out " + (j.result === "win" ? "ok" : "");
          out.textContent = "Result: " + j.result + "\\nPayout: " + fmt(j.payout);
          viz.textContent = "Player: " + (j.player||[]).join(" ") + " (" + j.playerTotal + ") | Dealer: " + (j.dealer||[]).join(" ") + " (" + j.dealerTotal + ")";
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
    } else if (game === "crash") {
      document.getElementById("cr-play").onclick = async function () {
        const out = document.getElementById("cr-out");
        const meter = document.getElementById("cr-meter"), fill = document.getElementById("cr-fill");
        try {
          const j = await post("/api/casino/crash/play", {
            bet: Number(document.getElementById("cr-bet").value || 0),
            cashout: Number(document.getElementById("cr-mult").value || 0),
          });
          setBal(j.wallet); out.className = "out " + (j.win ? "ok" : "err");
          let x = 1.0;
          const target = Math.max(1, Number(j.crashPoint || 1));
          meter.textContent = "x1.00"; fill.style.width = "0%";
          const timer = setInterval(() => {
            x = Math.min(target, Number((x + 0.07).toFixed(2)));
            meter.textContent = "x" + x.toFixed(2);
            fill.style.width = Math.min(100, ((x - 1) / Math.max(0.01, target - 1)) * 100) + "%";
            if (x >= target) {
              clearInterval(timer);
              out.textContent = "Crash at x" + j.crashPoint + " · cashout x" + j.cashout + " · " + (j.win ? "WIN" : "LOSE") + " · payout " + fmt(j.payout);
            }
          }, 60);
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
    } else if (game === "mines") {
      var minesState = { active: false, tiles: 25, picked: [] };
      function drawGrid(tiles, picked, revealMines) {
        var g = document.getElementById("mi-grid"); g.innerHTML = "";
        for (var i = 0; i < tiles; i++) {
          var d = document.createElement("div");
          var isSafe = picked.indexOf(i) !== -1;
          var isMine = Array.isArray(revealMines) && revealMines.indexOf(i) !== -1;
          d.className = "tile" + (isSafe ? " safe" : "") + (isMine ? " err" : "");
          d.textContent = i + 1;
          d.dataset.idx = String(i);
          if (minesState.active && !isSafe) {
            d.style.cursor = "pointer";
            d.onclick = async function () {
              var idx = Number(this.dataset.idx || -1);
              if (idx < 0) return;
              const out = document.getElementById("mi-out");
              try {
                const j = await post("/api/casino/mines/pick", { tile: idx });
                setBal(j.wallet);
                if (j.hit_mine) {
                  minesState.active = false;
                  drawGrid(minesState.tiles, j.picked || [], j.reveal_mines || []);
                  out.className = "out err";
                  out.textContent = "Boom. You hit a mine.";
                } else {
                  minesState.picked = j.picked || [];
                  drawGrid(minesState.tiles, minesState.picked, null);
                  out.className = "out";
                  out.textContent = "Safe pick. Multiplier x" + j.multiplier + " · potential payout " + fmt(j.potential_payout);
                }
              } catch (e) { out.className = "out err"; out.textContent = e.message; }
            };
          }
          g.appendChild(d);
        }
      }
      drawGrid(25, [], null);
      document.getElementById("mi-start").onclick = async function () {
        const out = document.getElementById("mi-out");
        try {
          const j = await post("/api/casino/mines/start", {
            bet: Number(document.getElementById("mi-bet").value || 0),
            tiles: Number(document.getElementById("mi-tiles").value || 25),
            mines: Number(document.getElementById("mi-mines").value || 3),
          });
          setBal(j.wallet);
          minesState.active = true;
          minesState.tiles = j.tiles;
          minesState.picked = [];
          drawGrid(j.tiles, [], null);
          out.className = "out";
          out.textContent = "Game started. Click tiles to reveal safe spots.";
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
      document.getElementById("mi-cashout").onclick = async function () {
        const out = document.getElementById("mi-out");
        try {
          const j = await post("/api/casino/mines/cashout", {});
          minesState.active = false;
          setBal(j.wallet);
          drawGrid(j.tiles, j.picked || [], null);
          out.className = "out ok";
          out.textContent = "Cashed out at x" + j.multiplier + " · payout " + fmt(j.payout);
        } catch (e) { out.className = "out err"; out.textContent = e.message; }
      };
    }
  </script>
</body>
</html>`;
}

module.exports = {
  attachArchiveSystem,
  logAccess,
  escapeHtml,
};
