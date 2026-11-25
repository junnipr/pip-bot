
// =========================================================================
// 01 — ENVIRONMENT, BOT CLIENT, AND TUNABLE LIMITS
// =========================================================================
/**
 * Pip v2.0 — automatic RP chart roster (compatible with previous Pip settings).
 *
 * Entrypoint: bot.js (single-file, drop-in replacement for GitHub/Railway).
 * Member commands: !rpcheck and /rpcheck. All other prefix commands are disabled.
 * Staff commands: slash commands. Keeps Tupperbox attribution, charts, forum/threads,
 * webhook mirroring, message links, and persistent /data storage behavior.
 *
 * Sections (ordered by responsibility):
 *  01. Environment and Discord client
 *  02. General utilities and concurrency helpers
 *  03. Persistent settings and chart storage
 *  04. Permissions and interaction responses
 *  05. Channel validation and Tupperbox attribution
 *  06. RP scanning and Discord message utilities
 *  07. Chart collection and rendering
 *  08. Audit report formatting and delivery
 *  09. Audit job queue and background dashboard updates
 *  10. Slash commands and help embeds
 *  11. Discord events and startup
 */
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  WebhookClient,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const STAFF_ROLE_IDS = new Set(
  (process.env.STAFF_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean)
);
// On Railway, a connected Volume automatically supplies RAILWAY_VOLUME_MOUNT_PATH.
// Store mutable configuration there rather than in /app, which is replaced on deploy.
// PIP_DATA_DIR is an optional override for other hosts; use an absolute path.
const DATA_DIR = process.env.PIP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'rpcheck-config.json');
const CHART_PATH = path.join(DATA_DIR, 'rpcheck-chart.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, 'rpcheck-config.json');
const MAX_PAGES_PER_CHANNEL = 50; // 5,000 recent messages per text channel or forum post
const MAX_THREADS_PER_PARENT = 300;
const MAX_ARCHIVED_THREAD_PAGES = 5;
// Keep concurrency bounded: Discord enforces per-route and global API limits.
const MAX_CONCURRENT_SOURCES = 2;
const MAX_CONCURRENT_THREADS = 3;
const MAX_CONCURRENT_AUDITS = 2;
const SCAN_CACHE_MS = 45_000;
const TUPPER_CACHE_MS = 90_000;
const MAX_SCAN_CACHE_ENTRIES = 800;
const channelScanCache = new Map();
const tupperOwnerCache = new Map();


const TUPPERBOX_BOT_ID = process.env.PIP_TUPPERBOX_BOT_ID || '431544605209788416';
const AUDIT_WEBHOOK_URL = process.env.PIP_AUDIT_WEBHOOK_URL || '';
// Must specify a single guild to prevent leaking audits from other servers.
const AUDIT_WEBHOOK_GUILD_ID = process.env.PIP_AUDIT_WEBHOOK_GUILD_ID || '';
const mirrorWebhook = AUDIT_WEBHOOK_URL && /^https:\/\/(discord(?:app)?\.com)\/api\/webhooks\/\d+\/[^\s]+$/.test(AUDIT_WEBHOOK_URL)
  && /^\d{17,22}$/.test(AUDIT_WEBHOOK_GUILD_ID)
  ? new WebhookClient({ url: AUDIT_WEBHOOK_URL }) : null;
if (AUDIT_WEBHOOK_URL && !mirrorWebhook) {
  console.warn('Pip audit webhook DISABLED: set valid PIP_AUDIT_WEBHOOK_URL and PIP_AUDIT_WEBHOOK_GUILD_ID.');
}


if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required for guildMemberAdd/Remove and full chart roster sync
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});


// =========================================================================
// 02 — GENERAL UTILITIES, CACHES, AND BOUNDED CONCURRENCY
// =========================================================================
async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }));
}

function snowflakeTimestamp(id) {
  if (!/^\d{17,22}$/.test(String(id || ''))) return null;
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); }
  catch { return null; }
}

function invalidateChannelCache(channelId) {
  for (const key of channelScanCache.keys()) {
    if (key.startsWith(`${channelId}:`)) channelScanCache.delete(key);
  }
}


// =========================================================================
// 03 — PERSISTENT SERVER CONFIGURATION AND CHART DATA
// =========================================================================
// Fail rather than overwrite unreadable data with a blank configuration.
fs.mkdirSync(DATA_DIR, { recursive: true });
if (CONFIG_PATH !== LEGACY_CONFIG_PATH && !fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
  fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
  console.log(`Migrated existing configuration to ${CONFIG_PATH}`);
}
let db = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    db = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('Configuration must be an object');
  } catch (error) {
    console.error(`Cannot read ${CONFIG_PATH}:`, error);
    process.exit(1);
  }
}
console.log(`Pip config path: ${CONFIG_PATH}`);
if (process.env.RAILWAY_PROJECT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.PIP_DATA_DIR) {
  console.warn('WARNING: No Railway Volume found. RP settings may reset on redeployment.');
}

function settings(guildId) {
  if (!db[guildId]) {
    db[guildId] = { rpChannels: [], logChannel: null, checkChannel: null, tupperLogChannel: null, hours: 48 };
  }
  if (!Object.hasOwn(db[guildId], 'tupperLogChannel')) db[guildId].tupperLogChannel = null;
  return db[guildId];
}

function saveSettings() {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// The chart uses Discord user IDs as keys, never nicknames. Its file lives on the
// SAME Railway Volume as rpcheck-config.json. No message bodies are stored here.
let chartDb = {};
if (fs.existsSync(CHART_PATH)) {
  try {
    chartDb = JSON.parse(fs.readFileSync(CHART_PATH, 'utf8'));
    if (!chartDb || typeof chartDb !== 'object' || Array.isArray(chartDb)) throw new Error('Invalid chart data');
  } catch (error) {
    console.error(`Cannot read ${CHART_PATH} (not overwriting it):`, error);
    process.exit(1);
  }
}
console.log(`Pip chart path: ${CHART_PATH}`);

function chartSettings(guildId) {
  if (!chartDb[guildId]) {
    chartDb[guildId] = {
      checks: {}, activity: {}, trackedIds: [], lastRefreshedAt: 0,
      refreshedForHours: null, warnings: [], dashboard: null,
    };
  }
  const chart = chartDb[guildId];
  chart.checks ||= {};
  chart.activity ||= {};
  chart.trackedIds ||= []; // Legacy name retained so older chart files still load
  chart.rosterSyncedAt ||= 0;
  chart.warnings ||= [];
  return chart;
}

function saveChart() {
  // Keep only the last 31 days of check-in timestamps, and at most 40 per member.
  const cutoff = Date.now() - 31 * 24 * 60 * 60 * 1000;
  for (const chart of Object.values(chartDb)) {
    for (const [id, history] of Object.entries(chart.checks || {})) {
      if (!Array.isArray(history)) { delete chart.checks[id]; continue; }
      const recent = history.filter(t => Number.isFinite(t) && t >= cutoff).slice(-40);
      if (recent.length) chart.checks[id] = recent;
      else delete chart.checks[id];
    }
  }
  const temporary = `${CHART_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(chartDb, null, 2));
  fs.renameSync(temporary, CHART_PATH);
}

function recordCheckIn(guildId, userId, messageCount) {
  const chart = chartSettings(guildId);
  if (!chart.trackedIds.includes(userId)) chart.trackedIds.push(userId);
  const now = Date.now();
  chart.checks[userId] ||= [];
  chart.checks[userId].push(now);
  chart.activity[userId] = { count: messageCount, scannedAt: now, hours: settings(guildId).hours };
  saveChart();
}


// ---------------- AUTOMATIC CHART ROSTER ----------------
// Keep the old trackedIds storage key for backward compatibility, but populate
// it from Discord's real guild membership rather than manual /rpchart track.
// Never use nicknames as identity keys. Bots are excluded from the RP chart.
// Discord Developer Portal > Bot > Server Members Intent must be ON.
const activeRosterSyncs = new Map();
const rosterChangesDuringSync = new Map();
function eligibleRosterMember(member) {
  return Boolean(member?.id && member.user && !member.user.bot);
}

function memberJoinedChart(member) {
  if (!eligibleRosterMember(member)) return;
  const pending = rosterChangesDuringSync.get(member.guild.id);
  if (pending) pending.set(member.id, true);
  const chart = chartSettings(member.guild.id);
  if (chart.trackedIds.includes(member.id)) return;
  chart.trackedIds.push(member.id);
  saveChart();
  scheduleDashboardUpdate(member.guild);
}

function memberLeftChart(member) {
  if (!member?.guild || !member?.id) return;
  const pending = rosterChangesDuringSync.get(member.guild.id);
  if (pending) pending.set(member.id, false);
  const chart = chartSettings(member.guild.id);
  const before = chart.trackedIds.length;
  chart.trackedIds = chart.trackedIds.filter(id => id !== member.id);
  // Members who leave should no longer appear as "checked in" or "roleplayed".
  // This does not delete past staff audit reports in Discord.
  delete chart.checks[member.id];
  delete chart.activity[member.id];
  if (before !== chart.trackedIds.length) {
    saveChart();
    scheduleDashboardUpdate(member.guild);
  }
}

async function syncChartRoster(guild) {
  if (activeRosterSyncs.has(guild.id)) return activeRosterSyncs.get(guild.id);
  // Full member fetch is performed at startup / guild join, or on /rpchart sync;
  // it is not repeated each time staff open the chart.
  const changes = new Map();
  rosterChangesDuringSync.set(guild.id, changes);
  const operation = (async () => {
    const allMembers = await guild.members.fetch();
    const roster = new Set();
    for (const member of allMembers.values()) {
      if (eligibleRosterMember(member)) roster.add(member.id);
    }
    // Preserve joins/leaves that happened while Discord was returning chunks.
    for (const [id, joined] of changes) {
      if (joined) roster.add(id);
      else roster.delete(id);
    }
    const chart = chartSettings(guild.id);
    chart.trackedIds = [...roster].sort();
    chart.rosterSyncedAt = Date.now();
    saveChart();
    scheduleDashboardUpdate(guild);
    console.log(`Pip roster: synchronized ${roster.size} human members in ${guild.name} (${guild.id})`);
    return { members: roster.size, at: chart.rosterSyncedAt };
  })();
  activeRosterSyncs.set(guild.id, operation);
  try { return await operation; }
  finally {
    activeRosterSyncs.delete(guild.id);
    if (rosterChangesDuringSync.get(guild.id) === changes) rosterChangesDuringSync.delete(guild.id);
  }
}


// =========================================================================
// 04 — STAFF PERMISSIONS AND SAFE REPLIES
// =========================================================================
function isInteractionManager(interaction) {
  return interaction.guild?.ownerId === interaction.user.id ||
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function isInteractionStaff(interaction) {
  if (isInteractionManager(interaction)) return true;
  const roles = interaction.member?.roles;
  return [...STAFF_ROLE_IDS].some(id => Array.isArray(roles) ? roles.includes(id) : Boolean(roles?.cache?.has(id)));
}

function slashAuditContext(interaction) {
  return {
    _interaction: interaction,
    guild: interaction.guild,
    author: interaction.user,
    channelId: interaction.channelId,
    content: `/${interaction.commandName}`,
    commandName: interaction.commandName,
    url: null,
  };
}

async function respondPrivately(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}


// =========================================================================
// 05 — SUPPORTED CHANNELS AND VERIFIED TUPPERBOX OWNERSHIP
// =========================================================================
function isSupportedChannel(channel) {
  return channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type);
}

function isSupportedMonitorChannel(channel) {
  return isSupportedChannel(channel) || channel?.type === ChannelType.GuildForum ||
    [ChannelType.PublicThread, ChannelType.AnnouncementThread, ChannelType.PrivateThread].includes(channel?.type);
}

async function reply(message, content) {
  if (message._interaction) return respondPrivately(message._interaction, content);
  return message.reply({ content, allowedMentions: { repliedUser: false, parse: [] } });
}


// Tupperbox logs are the source of truth for proxy-message ownership.
// The visible Tupper name alone is NOT enough to identify a Discord member.
// Tupperbox emits a staff log embed with "Registered by" and the original
// Discord message link / message ID. Ignore unverified proxies rather than guessing.
// Log layouts vary by Tupperbox release. We require *both* an identifiable
// owner AND the original proxied message ID, never just a character name.
// A malformed/ambiguous log is ignored to prevent false attribution.
const MESSAGE_LINK_RE = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{15,22})\/(\d{15,22})\/(\d{15,22})/gi;
const OWNER_ID_RE = /<@!?(\d{15,22})>|\((\d{15,22})\)|(?:discord\s*)?(?:user|owner|member)\s*id\s*[:#]?\s*(\d{15,22})/i;
function parseTupperLogEntry(message, guildId) {
  const embeds = message.embeds?.length ? message.embeds : [{ description: message.content || "" }];
  for (const embed of embeds) {
    const fields = embed.fields || [];
    const val = needle => fields.filter(f => String(f.name || '').toLowerCase().includes(needle))
      .map(f => String(f.value || '')).join('\n');
    const ownerSection = [
      val('registered by'), val('sent by'), val('proxy owner'), val('owner'),
      val('proxy user'), val('user id'), val('member'),
    ].filter(Boolean).join('\n');
    const body = [
      String(message.content || ''), String(embed.description || ''),
      String(embed.title || ''), String(embed.author?.name || ''),
      String(embed.footer?.text || ''),
      ...fields.map(f => `${f.name}: ${f.value}`),
    ].join('\n');
    // If an explicit owner field exists, use ONLY that field; never infer an
    // owner from a link to a discussion/quoted message within the RP content.
    const ownerBlock = ownerSection || body.match(/(?:registered by|sent by|proxy owner|tupper owner|owner|user id)\s*[:\-]?\s*([^\n]+)/i)?.[1] || '';
    const ownerMatch = ownerBlock.match(OWNER_ID_RE)
      || ownerBlock.match(/(?:^|\D)(\d{15,22})(?:\D|$)/);
    const ownerId = ownerMatch?.[1] || ownerMatch?.[2] || ownerMatch?.[3];
    if (!ownerId) continue;

    // Favor the explicit original-message link field if present. If we cannot
    // identify one, accept a *single* original Discord link in metadata.
    const originalField = [val('original message'), val('jump to message'), val('message link')]
      .filter(Boolean).join('\n');
    const linksIn = text => [...String(text).matchAll(MESSAGE_LINK_RE)]
      .filter(m => m[1] === guildId).map(m => m[3]);
    const explicit = linksIn(originalField);
    const links = explicit.length ? explicit : linksIn(body);
    const uniqueLinks = [...new Set(links)];
    let messageId = uniqueLinks.length === 1 ? uniqueLinks[0] : null;
    // A log may put its original-message ID in the footer rather than a URL.
    const idText = [val('message id'), String(embed.footer?.text || '')].join(' ');
    const idMatch = idText.match(/(?:original\s*)?message\s*id[^\d]*(\d{15,22})/i)
      || idText.trim().match(/^(\d{15,22})$/);
    if (!messageId && uniqueLinks.length === 0 && idMatch) messageId = idMatch[1];
    if (messageId && idMatch && messageId !== idMatch[1]) continue;
    if (!messageId) continue;
    // Discord IDs are stable. Never derive an owner from Tupper display names.
    return { messageId, ownerId, tupperName: String(embed.title || embed.author?.name || '').slice(0, 80) };
  }
  return null;
}

// The return stats deliberately omit message text, IDs and member identities.
// They help staff distinguish missing logs from unsupported log formatting.
async function loadTupperOwnersUncached(guild, cutoff, diagnostic = false) {
  const cfg = settings(guild.id);
  const owners = new Map();
  const warnings = [];
  const stats = { logChannelConfigured: Boolean(cfg.tupperLogChannel), accessible: false,
    inspected: 0, officialLogMessages: 0, attributed: 0, unparsedOfficial: 0,
    otherAuthors: 0, sampleFieldNames: [] };
  if (!cfg.tupperLogChannel) return { owners, warnings, stats };
  const channel = await guild.channels.fetch(cfg.tupperLogChannel).catch(() => null);
  if (!isSupportedChannel(channel)) {
    warnings.push('Tupperbox log channel missing or inaccessible; Tupper RP cannot be credited.');
    return { owners, warnings, stats };
  }
  stats.accessible = true;
  let before;
  const pageLimit = diagnostic ? 1 : MAX_PAGES_PER_CHANNEL;
  for (let page = 0; page < pageLimit; page++) {
    try {
      const batch = await channel.messages.fetch({ limit: diagnostic ? 50 : 100, cache: false, ...(before ? { before } : {}) });
      if (!batch.size) break;
      const messages = [...batch.values()];
      let older = false;
      for (const m of messages) {
        if (m.createdTimestamp < cutoff) { older = true; break; }
        stats.inspected++;
        if (m.author?.id !== TUPPERBOX_BOT_ID) { stats.otherAuthors++; continue; }
        stats.officialLogMessages++;
        const ownership = parseTupperLogEntry(m, guild.id);
        if (ownership) {
          owners.set(ownership.messageId, ownership);
          stats.attributed++;
        } else {
          stats.unparsedOfficial++;
          if (!stats.sampleFieldNames.length) {
            stats.sampleFieldNames = [...new Set((m.embeds || []).flatMap(e =>
              (e.fields || []).map(f => String(f.name).slice(0, 60))))].slice(0, 8);
          }
        }
      }
      if (older || batch.size < (diagnostic ? 50 : 100)) break;
      before = messages[messages.length - 1].id;
      if (!diagnostic && page === MAX_PAGES_PER_CHANNEL - 1) warnings.push('Tupperbox log reached 5,000-message scan cap; some proxy messages may be missing.');
    } catch (err) {
      console.error('Cannot read Tupperbox logs:', err);
      warnings.push('Unable to read Tupperbox log history; Tupper messages may be undercounted.');
      break;
    }
  }
  if (stats.officialLogMessages && !stats.attributed) {
    warnings.push('Tupperbox logs found but no ownership could be parsed. Run /tupperdiagnose and share a redacted example log embed to fix its layout.');
  } else if (stats.inspected && !stats.officialLogMessages) {
    warnings.push('Messages found in Tupperbox log channel, but none from the configured official Tupperbox bot ID. Verify the log source and bot ID.');
  }
  return { owners, warnings, stats };
}

// Cache Tupperbox ownership briefly. A new official Tupperbox log invalidates it.
// Diagnostics always fetch fresh data so permission / formatting problems are visible.
async function getTupperOwners(guild, cutoff, diagnostic = false) {
  if (diagnostic) return loadTupperOwnersUncached(guild, cutoff, true);
  const cached = tupperOwnerCache.get(guild.id);
  if (cached && cached.cutoff <= cutoff && cached.expiresAt > Date.now()) return cached.promise;
  const promise = loadTupperOwnersUncached(guild, cutoff).catch(error => {
    if (tupperOwnerCache.get(guild.id)?.promise === promise) tupperOwnerCache.delete(guild.id);
    throw error;
  });
  tupperOwnerCache.set(guild.id, { cutoff, expiresAt: Date.now() + TUPPER_CACHE_MS, promise });
  return promise;
}


// =========================================================================
// 06 — SCAN RP MESSAGES, PUBLIC THREADS, AND FORUM POSTS
// =========================================================================
// Read a configurable time window, paging backward until before the cutoff.
async function scanChannel(channel, userId, cutoff, owners = new Map()) {
  const key = `${channel.id}:${userId || 'all'}`;
  const hit = channelScanCache.get(key);
  if (hit && hit.expiresAt > Date.now() && hit.cutoff <= cutoff) {
    return { matches: hit.matches.filter(m => m.createdTimestamp >= cutoff), truncated: hit.truncated };
  }
  if (hit) channelScanCache.delete(key);
  let before;
  let truncated = false;
  const matches = [];

  for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
    const options = { limit: 100, cache: false };
    if (before) options.before = before;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    const messages = [...batch.values()];
    let foundOldMessage = false;
    for (const m of messages) {
      if (m.createdTimestamp < cutoff) {
        foundOldMessage = true;
        break;
      }
      const attribution = m.webhookId ? owners.get(m.id) : null;
      const ownerId = attribution?.ownerId || (!m.author.bot && !m.webhookId ? m.author.id : null);
      if (ownerId && (!userId || ownerId === userId)) {
        m._pipOwnerId = ownerId;
        m._pipTupperName = attribution ? (attribution.tupperName || m.author.username) : null;
        matches.push(m);
      }
    }

    if (foundOldMessage || batch.size < 100) break;
    before = messages[messages.length - 1].id;
    if (page === MAX_PAGES_PER_CHANNEL - 1) truncated = true;
  }
  // Cache matched messages only (not every scanned message), avoiding huge memory use.
  // New messages and Tupperbox log entries invalidate affected cached scans.
  if (matches.length <= 150) {
    if (channelScanCache.size >= MAX_SCAN_CACHE_ENTRIES) {
      channelScanCache.delete(channelScanCache.keys().next().value);
    }
    channelScanCache.set(key, { matches, truncated, cutoff, expiresAt: Date.now() + SCAN_CACHE_MS });
  }
  return { matches, truncated };
}

// Public posts in forums are threads. Regular text channels also have threads.
// We scan PUBLIC threads automatically under a configured parent channel.
// A private thread is scanned only if explicitly configured by ID and readable by Pip.
async function collectPublicThreads(parent, cutoff) {
  const threads = new Map();
  const warnings = [];
  try {
    const active = await parent.threads.fetchActive(false);
    for (const thread of active.threads.values()) {
      if (thread.type === ChannelType.PrivateThread) continue;
      if (threads.size >= MAX_THREADS_PER_PARENT) {
        warnings.push(`#${parent.name}: reached ${MAX_THREADS_PER_PARENT}-thread cap`);
        break;
      }
      threads.set(thread.id, thread);
    }
  } catch (error) {
    console.error(`Cannot list active threads in ${parent.name}:`, error);
    warnings.push(`#${parent.name}: could not list active threads`);
  }

  let before;
  if (threads.size < MAX_THREADS_PER_PARENT) {
    try {
      for (let page = 0; page < MAX_ARCHIVED_THREAD_PAGES; page++) {
        const opts = { type: 'public', limit: 100 };
        if (before) opts.before = before;
        const result = await parent.threads.fetchArchived(opts, false);
        const archived = [...result.threads.values()];
        if (!archived.length) break;
        let earliest = Infinity;
        for (const thread of archived) {
          const stamp = thread.archiveTimestamp ?? thread.createdTimestamp ?? Date.now();
          earliest = Math.min(earliest, stamp);
          if (stamp < cutoff || threads.has(thread.id)) continue;
          if (threads.size >= MAX_THREADS_PER_PARENT) {
            warnings.push(`#${parent.name}: reached ${MAX_THREADS_PER_PARENT}-thread cap`);
            break;
          }
          threads.set(thread.id, thread);
        }
        if (threads.size >= MAX_THREADS_PER_PARENT || !result.hasMore || earliest < cutoff) break;
        if (page === MAX_ARCHIVED_THREAD_PAGES - 1) {
          warnings.push(`#${parent.name}: reached archived-thread pagination cap`);
          break;
        }
        before = new Date(earliest - 1);
      }
    } catch (error) {
      console.error(`Cannot list archived threads in ${parent.name}:`, error);
      warnings.push(`#${parent.name}: could not list archived public threads`);
    }
  }
  return { threads: [...threads.values()], warnings };
}

async function scanChildThreads(parent, userId, cutoff, owners = new Map()) {
  const { threads, warnings } = await collectPublicThreads(parent, cutoff);
  const matches = [];
  let searchedThreads = 0;
  await mapWithConcurrency(threads, MAX_CONCURRENT_THREADS, async thread => {
    // The last message Snowflake tells us whether the thread could contain
    // RP activity inside the requested window. Unknown IDs are never skipped.
    const lastMessageAt = snowflakeTimestamp(thread.lastMessageId);
    if (lastMessageAt && lastMessageAt < cutoff) return;
    try {
      const result = await scanChannel(thread, userId, cutoff, owners);
      searchedThreads++;
      matches.push(...result.matches);
      if (result.truncated) warnings.push(`#${parent.name} / ${thread.name}: reached 5,000-message cap`);
    } catch (error) {
      console.error(`Cannot read thread ${thread.id}:`, error);
      warnings.push(`#${parent.name} / ${thread.name}: could not read messages`);
    }
  });
  return { matches, warnings, searchedThreads };
}


// =========================================================================
// 07 — AUTOMATIC MEMBER ROSTER, CHART REFRESH, AND DASHBOARD
// =========================================================================
function cleanNick(name) {
  return truncate(String(name || 'Unknown member').replace(/[\r\n`*_~|<>]/g, ' ').replace(/@everyone|@here/gi, '[mention]'), 54);
}

async function getLiveServerName(guild, userId) {
  // force: true retrieves the CURRENT nickname, rather than a stale member cache.
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member) return cleanNick(member.displayName);
  } catch (_error) {
    // The member may have left, or Pip cannot fetch them.
  }
  try {
    const user = await client.users.fetch(userId);
    return `${cleanNick(user.globalName || user.username)} (not in server)`;
  } catch (_error) {
    return `Unknown user (${userId})`;
  }
}

// Reads all monitored sources once, collecting activity across ALL authors rather
// than requiring each member to submit a check. This can be an expensive operation
// on busy servers; use /rpchart refresh when staff need a current snapshot.
async function refreshActivityChart(guild) {
  const cfg = settings(guild.id);
  if (!cfg.rpChannels.length) throw new Error('No RP channels configured. Use /rpadd first.');
  const cutoff = Date.now() - cfg.hours * 60 * 60 * 1000;
  const uniqueMessages = new Map();
  const { owners, warnings: ownershipWarnings } = await getTupperOwners(guild, cutoff);
  const warnings = [...ownershipWarnings];
  await mapWithConcurrency(cfg.rpChannels, MAX_CONCURRENT_SOURCES, async id => {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!isSupportedMonitorChannel(channel)) {
      warnings.push(`Monitored source ${id} is missing or unsupported`);
      return;
    }
    try {
      if (channel.type === ChannelType.GuildForum) {
        const result = await scanChildThreads(channel, null, cutoff, owners);
        result.matches.forEach(m => uniqueMessages.set(m.id, m));
        warnings.push(...result.warnings);
      } else if (channel.isThread()) {
        const result = await scanChannel(channel, null, cutoff, owners);
        result.matches.forEach(m => uniqueMessages.set(m.id, m));
        if (result.truncated) warnings.push(`${channel.name}: scan limit reached`);
      } else {
        const [own, children] = await Promise.all([
          scanChannel(channel, null, cutoff, owners), scanChildThreads(channel, null, cutoff, owners),
        ]);
        [...own.matches, ...children.matches].forEach(m => uniqueMessages.set(m.id, m));
        if (own.truncated) warnings.push(`${channel.name}: scan limit reached`);
        warnings.push(...children.warnings);
      }
    } catch (error) {
      console.error(`Cannot refresh chart for ${id}`, error);
      warnings.push(`${channel.name}: messages inaccessible`);
    }
  });
  const chart = chartSettings(guild.id);
  const at = Date.now();
  const activity = {};
  for (const m of uniqueMessages.values()) {
    const id = m._pipOwnerId;
    if (!id) continue;
    if (!activity[id]) activity[id] = { count: 0, scannedAt: at, hours: cfg.hours };
    activity[id].count++;
  }
  chart.activity = activity;
  chart.lastRefreshedAt = at;
  chart.refreshedForHours = cfg.hours;
  chart.warnings = warnings.slice(0, 50);
  saveChart();
  return { members: Object.keys(activity).length, messages: uniqueMessages.size, warnings };
}

const CHART_PAGE_SIZE = 10;
// Staff can move between pages from the ephemeral /rpchart view itself.
// All values are still computed from the existing ID-keyed chart database.
function chartPageButtons(page, totalPages) {
  if (totalPages <= 1) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pip:chart:${Math.max(1, page - 1)}`)
      .setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`pip:chart:${Math.min(totalPages, page + 1)}`)
      .setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages),
  )];
}
async function buildChartEmbed(guild, pageNumber = 1) {
  const cfg = settings(guild.id);
  const chart = chartSettings(guild.id);
  const cutoff = Date.now() - cfg.hours * 3600000;
  const checkers = new Set(Object.entries(chart.checks)
    .filter(([, history]) => Array.isArray(history) && history.some(t => t >= cutoff))
    .map(([id]) => id));
  const activeIds = Object.entries(chart.activity)
    .filter(([, a]) => a?.count > 0 && a.hours === cfg.hours && a.scannedAt >= cutoff)
    .map(([id]) => id);
  const ids = new Set(chart.rosterSyncedAt
    ? chart.trackedIds // Once synced, show CURRENT server members, including zero-activity users.
    : [...chart.trackedIds, ...checkers, ...activeIds]);
  const hasFreshScan = Boolean(chart.lastRefreshedAt && chart.refreshedForHours === cfg.hours && chart.lastRefreshedAt >= cutoff);
  const rows = [...ids].map(id => {
    const recentScan = chart.activity[id]?.hours === cfg.hours && chart.activity[id]?.scannedAt >= cutoff ? chart.activity[id] : null;
    const rpCount = recentScan?.count ?? (hasFreshScan ? 0 : null);
    return { id, checked: checkers.has(id), rpCount };
  }).sort((a, b) => Number(b.checked) - Number(a.checked) ||
    Number(b.rpCount > 0) - Number(a.rpCount > 0) || (b.rpCount ?? 0) - (a.rpCount ?? 0) || a.id.localeCompare(b.id));
  const totalPages = Math.max(1, Math.ceil(rows.length / CHART_PAGE_SIZE));
  const page = Math.min(Math.max(1, pageNumber), totalPages);
  const items = rows.slice((page - 1) * CHART_PAGE_SIZE, page * CHART_PAGE_SIZE);
  const names = await Promise.all(items.map(item => getLiveServerName(guild, item.id)));
  const lines = items.map((item, i) => {
    const check = item.checked ? '✅' : '➖';
    const played = item.rpCount === null ? '❔' : item.rpCount > 0 ? '✅' : '➖';
    const count = item.rpCount > 0 ? ` · **${item.rpCount}** messages` : '';
    // One member per line; clicking their profile mention is useful for staff.
    return `${check}  ${played}  **${truncate(names[i].replace(/[\r\n]/g, ' '), 55)}**${count}`;
  });
  const checkedCount = rows.filter(r => r.checked).length;
  const activeCount = rows.filter(r => r.rpCount > 0).length;
  const refreshLine = hasFreshScan
    ? `<t:${Math.floor(chart.lastRefreshedAt / 1000)}:R>`
    : 'Not refreshed for this window';
  const embed = new EmbedBuilder().setColor(0x8b79db)
    .setTitle('📊 Pip | Member Activity')
    .setDescription('**✅** Yes  •  **➖** No  •  **❔** Needs scan\nColumns: **RP check**  /  **Roleplayed**  /  **Server name**')
    .addFields(
      { name: '✅ Checked in', value: String(checkedCount), inline: true },
      { name: '✍️ Roleplayed', value: String(activeCount), inline: true },
      { name: '👥 Listed members', value: String(rows.length), inline: true },
      { name: `Members • Page ${page}/${totalPages}`, value: lines.length ? truncate(lines.join('\n'), 1020) : 'Roster not loaded yet. Use `/rpchart sync` to list everyone.' },
      { name: '📅 Tracking window', value: `Last **${cfg.hours} hours** • RP scan: ${refreshLine}` },
      { name: '👤 Server roster', value: chart.rosterSyncedAt ? `Synced <t:${Math.floor(chart.rosterSyncedAt / 1000)}:R> • new joins added automatically` : 'Not yet synced • use `/rpchart sync`' },
    )
    .setFooter({ text: 'Staff only • Auto-roster for human members • Nicknames refresh on view' });
  if (hasFreshScan && chart.warnings.length) {
    embed.addFields({ name: '⚠️ Scan limits', value: `${chart.warnings.length} source warning(s) — counts may be incomplete.` });
  }
  return { embed, page, totalPages, tracked: rows.length };
}

async function updateChartDashboard(guild) {
  const cfg = settings(guild.id);
  if (!cfg.logChannel) throw new Error('Set /rplogchannel before posting the chart.');
  const channel = await guild.channels.fetch(cfg.logChannel).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.send) throw new Error('Cannot access staff log channel.');
  const chart = chartSettings(guild.id);
  const { embed, totalPages } = await buildChartEmbed(guild, 1);
  const payload = {
    content: `PIP RP CHART | ${guild.id} | Staff dashboard${totalPages > 1 ? ` (page 1/${totalPages}; use /rpchart view for remaining pages)` : ''}`,
    embeds: [embed], allowedMentions: { parse: [] },
  };
  if (chart.dashboard?.channelId === channel.id && chart.dashboard?.messageId) {
    const previous = await channel.messages.fetch(chart.dashboard.messageId).catch(() => null);
    if (previous) {
      await previous.edit(payload);
      return previous;
    }
  }
  const posted = await channel.send(payload);
  chart.dashboard = { channelId: channel.id, messageId: posted.id };
  saveChart();
  return posted;
}


// =========================================================================
// 08 — AUDIT FORMATTING, WEBHOOK MIRROR, AND STAFF REPORTS
// =========================================================================
function cleanContent(message) {
  let preview = (message.content || '').replace(/\s+/g, ' ').trim();
  if (!preview) {
    preview = message.attachments?.size ? `[${message.attachments.size} attachment(s)]` :
      message.embeds?.length ? '[embed]' :
      message.stickers?.size ? '[sticker]' : '[no text]';
  }
  // Show a safe, short excerpt. Original content stays in Discord.
  preview = preview.replace(/@everyone/g, '@ everyone').replace(/@here/g, '@ here');
  preview = preview.replace(/[`*_~|>]/g, ' ').replace(/\s+/g, ' ').trim();
  return preview.length > 170 ? `${preview.slice(0, 167)}...` : preview;
}

function getLocationLabel(channel) {
  if (!channel.isThread?.()) return `#${channel.name}`;
  const parent = channel.parent;
  const type = parent?.type === ChannelType.GuildForum ? 'Forum' : 'Thread';
  return `${type} #${parent?.name || 'unknown'} / ${channel.name}`;
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

// Keep each staff-log message under Discord's 2,000-character limit.
// Include the member's permanent ID on EVERY page so searching staff logs works.
function paginateDetails(header, lines, maximum = 1850) {
  const pages = [];
  let body = header;
  for (const line of lines) {
    if (body.length + line.length + 1 > maximum && body !== header) {
      pages.push(body.trimEnd());
      body = header;
    }
    if (line.length + header.length + 1 > maximum) {
      // Defensive fallback for unexpected long forum/thread names.
      const safe = truncate(line, maximum - header.length - 2);
      body += `${safe}\n`;
      continue;
    }
    body += `${line}\n`;
  }
  if (body.trim() !== header.trim()) pages.push(body.trimEnd());
  return pages;
}


// The optional webhook should never hold up a member's ✅ or their primary staff report.
// Preserve webhook message order and log any delivery errors.
let webhookQueue = Promise.resolve();
async function sendAuditToStaff(logChannel, payload, guildId) {
  const posted = await logChannel.send(payload);
  if (mirrorWebhook && guildId === AUDIT_WEBHOOK_GUILD_ID) {
    webhookQueue = webhookQueue.then(() => mirrorWebhook.send({
      ...payload, username: 'Pip RP Audit', allowedMentions: { parse: [] },
    })).catch(error => console.error('Could not mirror staff audit to webhook:', error));
  }
  return posted;
}


async function runAudit(originMessage, targetUser) {
  const auditStartedAt = Date.now();
  const cfg = settings(originMessage.guild.id);
  if (!cfg.logChannel || cfg.rpChannels.length === 0) {
    return reply(originMessage, 'RP check is not configured yet. Staff: use `/rplogchannel` and `/rpadd`.');
  }

  const logChannel = await originMessage.guild.channels.fetch(cfg.logChannel).catch(() => null);
  if (!logChannel?.isTextBased() || !logChannel.send) {
    return reply(originMessage, 'The staff log channel is missing or inaccessible. Ask staff to use `/rplogchannel`.');
  }

  const cutoff = Date.now() - cfg.hours * 60 * 60 * 1000;
  const foundById = new Map(); // avoids duplicate results when both a parent and its thread are configured
  const { owners, warnings: ownershipWarnings } = await getTupperOwners(originMessage.guild, cutoff);
  const warnings = [...ownershipWarnings];
  let scannedSources = 0;
  let scannedPosts = 0;

  await mapWithConcurrency(cfg.rpChannels, MAX_CONCURRENT_SOURCES, async channelId => {
    const channel = await originMessage.guild.channels.fetch(channelId).catch(() => null);
    if (!isSupportedMonitorChannel(channel)) {
      warnings.push(`Channel ID ${channelId}: missing or unsupported`);
      return;
    }
    scannedSources++;
    try {
      if (channel.type === ChannelType.GuildForum) {
        const result = await scanChildThreads(channel, targetUser.id, cutoff, owners);
        scannedPosts += result.searchedThreads;
        for (const m of result.matches) foundById.set(m.id, m);
        warnings.push(...result.warnings);
      } else if (channel.isThread()) {
        const result = await scanChannel(channel, targetUser.id, cutoff, owners);
        for (const m of result.matches) foundById.set(m.id, m);
        if (result.truncated) warnings.push(`${channel.name}: reached 5,000-message scan limit`);
      } else {
        const [own, child] = await Promise.all([
          scanChannel(channel, targetUser.id, cutoff, owners),
          scanChildThreads(channel, targetUser.id, cutoff, owners),
        ]);
        scannedPosts += child.searchedThreads;
        for (const m of [...own.matches, ...child.matches]) foundById.set(m.id, m);
        if (own.truncated) warnings.push(`${channel.name}: reached 5,000-message scan limit`);
        warnings.push(...child.warnings);
      }
    } catch (error) {
      console.error(`Cannot audit channel ${channelId}:`, error);
      warnings.push(`${channel.name}: could not read message history`);
    }
  });

  const found = [...foundById.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const byLocation = new Map();
  for (const message of found) {
    if (!byLocation.has(message.channelId)) {
      byLocation.set(message.channelId, { channel: message.channel, messages: [] });
    }
    byLocation.get(message.channelId).messages.push(message);
  }
  // Put the most active RP locations first; nothing with zero messages appears.
  const locations = [...byLocation.values()].sort((a, b) =>
    b.messages.length - a.messages.length || b.messages[0].createdTimestamp - a.messages[0].createdTimestamp);
  const characters = new Map();
  for (const m of found) if (m._pipTupperName) characters.set(m._pipTupperName, (characters.get(m._pipTupperName) || 0) + 1);
  const time = Math.floor(Date.now() / 1000);
  const liveName = await getLiveServerName(originMessage.guild, targetUser.id);
  const searchableTag = `RP AUDIT | ${liveName} | USER ID: ${targetUser.id}`;
  const linkToCheck = originMessage.url
    ? `Source check: ${originMessage.url}`
    : `Requested with /${originMessage.commandName} in <#${originMessage.channelId}>`;

  // Discord-facing audit layout: a compact overview followed by one embed per
  // actual RP channel / forum post / thread. No empty channel entries are shown.
  const status = warnings.length ? '⚠️ Some sources incomplete' : '✅ Completed';
  const tupperCount = [...characters.values()].reduce((n, x) => n + x, 0);
  const summaryEmbed = new EmbedBuilder()
    .setColor(warnings.length ? 0xe8a23a : 0x8b79db)
    .setTitle(`📋 RP Audit | ${truncate(liveName, 95)}`)
    .setDescription(`**Member:** ${truncate(liveName, 65)}\n**User ID:** \`${targetUser.id}\`\n**Requested by:** ${truncate(originMessage.author.username, 60)}\n**Status:** ${status}`)
    .addFields(
      { name: '✍️ Messages', value: String(found.length), inline: true },
      { name: '📍 Active locations', value: String(locations.length), inline: true },
      { name: '🎭 Tupper replies', value: String(tupperCount), inline: true },
      { name: '🕒 Audit period', value: `Last **${cfg.hours} hours** • <t:${time}:f>` },
    )
    .setFooter({ text: `Pip • ${scannedSources} sources checked • ${scannedPosts} threads/posts visited` });

  if (characters.size) {
    const charLines = [...characters.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 12).map(([n, c]) => `• **${truncate(n.replace(/[\r\n]/g, ' '), 62)}** — ${c}`);
    summaryEmbed.addFields({ name: '🎭 Credited characters', value: truncate(charLines.join('\n'), 1000) });
  }
  if (!locations.length) {
    summaryEmbed.addFields({ name: 'No RP found', value: 'No messages were detected in the configured sources for this time window.' });
  } else {
    // Only show the busiest active locations in the overview. Detailed pages
    // below cover every location and link to the exact original messages.
    const overview = locations.slice(0, 12).map(location => {
      const first = location.messages[0];
      const link = first.url || `https://discord.com/channels/${originMessage.guild.id}/${first.channelId}/${first.id}`;
      return `• **${location.messages.length}** · ${truncate(getLocationLabel(location.channel).replace(/[\r\n]/g, ' '), 66)} · [Open](${link})`;
    });
    if (locations.length > 12) overview.push(`…plus ${locations.length - 12} more locations in the detailed records below.`);
    summaryEmbed.addFields({ name: '📁 Where they roleplayed', value: truncate(overview.join('\n'), 1000) });
  }
  if (warnings.length) {
    summaryEmbed.addFields({ name: '⚠️ Scan notes', value: truncate(warnings.slice(0, 7).map(w => `• ${w}`).join('\n'), 1000) });
  }

  await sendReportTogether(async () => {
    // Keep the member's permanent user ID as searchable plain message content.
    await sendAuditToStaff(logChannel, {
      content: `${searchableTag}\n${linkToCheck}`,
      embeds: [summaryEmbed],
      allowedMentions: { parse: [] },
    }, originMessage.guild.id);

    // Readable embeds with each link labeled 'Open message', rather than an
    // uninterrupted wall of raw URLs. At most 7 records per embed page.
    const PAGE_SIZE = 7;
    for (const location of locations) {
      const place = truncate(getLocationLabel(location.channel).replace(/[\r\n]/g, ' '), 140);
      const pageCount = Math.ceil(location.messages.length / PAGE_SIZE);
      for (let page = 0; page < pageCount; page++) {
        const messages = location.messages.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const sections = messages.map((m, i) => {
          const stamp = Math.floor(m.createdTimestamp / 1000);
          const link = m.url || `https://discord.com/channels/${originMessage.guild.id}/${m.channelId}/${m.id}`;
          const who = m._pipTupperName ? `🎭 ${truncate(m._pipTupperName.replace(/[\r\n]/g, ' '), 45)} • ` : '';
          return `**${page * PAGE_SIZE + i + 1}.** ${who}<t:${stamp}:f> · [Open message](${link})\n${truncate(cleanContent(m), 135)}`;
        });
        const embed = new EmbedBuilder().setColor(0x9b8acb)
          .setTitle(`📍 ${place}`)
          .setDescription(sections.join('\n\n'))
          .setFooter({ text: `${location.messages.length} message(s) in this location • Page ${page + 1}/${pageCount} • Pip` });
        await sendAuditToStaff(logChannel, {
          content: `RP AUDIT | USER ID: ${targetUser.id} | ${truncate(liveName, 55)} | ${place} | ${page + 1}/${pageCount}`,
          embeds: [embed],
          allowedMentions: { parse: [] },
        }, originMessage.guild.id);
      }
    }
  });

  // Only a member's own successful !rpcheck or /rpcheck counts as a check-in.
  // Staff /rplog audits never count as submitted checks.
  const isSelfCheck = originMessage._interaction
    ? originMessage.commandName === 'rpcheck'
    : originMessage.content.trim().toLowerCase() === '!rpcheck';
  if (isSelfCheck) {
    try {
      recordCheckIn(originMessage.guild.id, targetUser.id, found.length);
      // Defer chart updates: 15 fresh nickname lookups + message edit are expensive.
      // Coalesced update runs shortly after the checkmark, not before it.
      scheduleDashboardUpdate(originMessage.guild);
    } catch (error) {
      console.error('Could not save/update check-in chart:', error);
    }
  }

  // Slash commands have no ordinary user message to react to. Confirm them
  // privately; retain ✅ on the original message for !rpcheck.
  const elapsed = ((Date.now() - auditStartedAt) / 1000).toFixed(1);
  console.log(`Pip audit: guild=${originMessage.guild.id}, member=${targetUser.id}, messages=${found.length}, sources=${scannedSources}, inspectedThreads=${scannedPosts}, seconds=${elapsed}`);
  if (originMessage._interaction) {
    await reply(originMessage, `✅ RP audit posted to <#${cfg.logChannel}>. Found **${found.length}** message(s) across **${locations.length}** active location(s). Completed in **${elapsed}s**.`);
  } else {
    await originMessage.react('✅').catch(() => {});
    await removePendingReaction(originMessage);
  }
}


// =========================================================================
// 09 — BOUNDED AUDIT QUEUE, REACTIONS, AND BACKGROUND UPDATES
// =========================================================================
// Only publishing to the staff channel is serialized; scanning can overlap.
let reportQueue = Promise.resolve();
function sendReportTogether(fn) {
  const task = reportQueue.then(fn);
  reportQueue = task.catch(() => {});
  return task;
}

// Never allow unlimited simultaneous full-history audits (avoids API floods).
let activeAuditJobs = 0;
const auditWaiters = [];
async function withAuditSlot(job) {
  if (activeAuditJobs >= MAX_CONCURRENT_AUDITS) {
    // This waiter receives the released slot directly (no concurrency race).
    await new Promise(resolve => auditWaiters.push(resolve));
  } else {
    activeAuditJobs++;
  }
  try { return await job(); }
  finally {
    const next = auditWaiters.shift();
    if (next) next();
    else activeAuditJobs--;
  }
}

async function removePendingReaction(message) {
  if (message._interaction) return;
  const reaction = message.reactions?.cache?.find(r => r.emoji.name === '⏳');
  if (reaction) await reaction.users.remove(client.user.id).catch(() => {});
}

const dashboardTimers = new Map();
function scheduleDashboardUpdate(guild) {
  if (!chartSettings(guild.id).dashboard?.messageId) return;
  if (dashboardTimers.has(guild.id)) clearTimeout(dashboardTimers.get(guild.id));
  dashboardTimers.set(guild.id, setTimeout(() => {
    dashboardTimers.delete(guild.id);
    updateChartDashboard(guild).catch(error => console.error('Could not refresh chart:', error));
  }, 1500));
}

function enqueueAudit(message, user) {
  const task = withAuditSlot(() => runAudit(message, user));
  task.catch(async error => {
    console.error('RP audit failed:', error);
    await removePendingReaction(message);
    if (!message._interaction) await message.react('❌').catch(() => {});
    await reply(message, 'Could not finish the audit. Check bot permissions and Railway Deploy Logs.').catch(() => {});
  }).finally(() => removePendingReaction(message).catch(() => {}));
  return task;
}


// =========================================================================
// 10 — SLASH COMMAND DEFINITIONS, HELP EMBEDS, AND ACCESS
// =========================================================================
// Slash commands are registered to each server after Pip connects. Guild commands
// normally appear immediately in Discord's / command picker (no portal form needed).
const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('rpcheck').setDescription('Submit your own RP activity check.'),
  new SlashCommandBuilder().setName('rplog').setDescription('Staff: audit a member’s recent RP messages.')
    .addUserOption(o => o.setName('member').setDescription('Member to audit').setRequired(true)),
  new SlashCommandBuilder().setName('rpadd').setDescription('Admin: monitor an RP channel, forum, or thread.')
    .addChannelOption(o => o.setName('channel').setDescription('RP channel or forum (including its public threads)').setRequired(false))
    .addStringOption(o => o.setName('thread_id').setDescription('Optional: exact thread ID instead of a channel').setRequired(false)),
  new SlashCommandBuilder().setName('rpremove').setDescription('Admin: stop monitoring an RP channel, forum, or thread.')
    .addChannelOption(o => o.setName('channel').setDescription('Previously monitored channel or forum').setRequired(false))
    .addStringOption(o => o.setName('thread_id').setDescription('Optional: exact thread ID instead of a channel').setRequired(false)),
  new SlashCommandBuilder().setName('rplist').setDescription('Staff: view Pip’s monitored sources and settings.'),
  new SlashCommandBuilder().setName('rphours').setDescription('Admin: set the RP audit lookback period.')
    .addIntegerOption(o => o.setName('hours').setDescription('1 to 336 hours; 168 = one week').setMinValue(1).setMaxValue(336).setRequired(true)),
  new SlashCommandBuilder().setName('rplogchannel').setDescription('Admin: set the private staff audit log channel.')
    .addChannelOption(o => o.setName('channel').setDescription('Staff-only text channel').setRequired(true)),
  new SlashCommandBuilder().setName('rpcheckchannel').setDescription('Admin: choose where members submit RP checks.')
    .addChannelOption(o => o.setName('channel').setDescription('Check-in text channel').setRequired(true)),
  new SlashCommandBuilder().setName('rphealth').setDescription('Staff: verify Pip’s settings storage on Railway.'),
  new SlashCommandBuilder().setName('tupperlogchannel').setDescription('Admin: set the private Tupperbox proxy-ownership log channel.')
    .addChannelOption(o => o.setName('channel').setDescription('Channel used by Tupperbox official proxy logs').setRequired(true)),
  new SlashCommandBuilder().setName('tupperdiagnose').setDescription('Staff: check whether Pip can read and attribute Tupperbox logs.'),
  new SlashCommandBuilder().setName('cmd').setDescription('Open Pip’s interactive command directory.')
    .addSubcommand(o => o.setName('list').setDescription('View the complete command directory.'))
    .addSubcommand(o => o.setName('info').setDescription('Learn about Pip and its audit reports.'))
    .addSubcommand(o => o.setName('setup').setDescription('Read the server setup guide.')),
  new SlashCommandBuilder().setName('rpchart').setDescription('Staff: view and update the RP check-in and activity chart.')
    .addSubcommand(o => o.setName('view').setDescription('View the RP activity and check-in chart.')
      .addIntegerOption(p => p.setName('page').setDescription('Chart page (10 members per page)').setMinValue(1).setRequired(false)))
    .addSubcommand(o => o.setName('refresh').setDescription('Scan monitored RP sources and refresh the chart.'))
    .addSubcommand(o => o.setName('post').setDescription('Post or update the chart in the private staff log.'))
    .addSubcommand(o => o.setName('sync').setDescription('Manager: add every current server member to the chart.')),
  new SlashCommandBuilder().setName('ping').setDescription('Check whether Pip is online and responsive.'),
];

async function registerGuildCommands(guild) {
  try {
    // Replace only Pip’s guild-level command list. This does not change bot files,
    // configuration, permissions, token, or posted audit reports.
    await guild.commands.set(SLASH_COMMANDS.map(command => command.toJSON()));
    console.log(`Published ${SLASH_COMMANDS.length} slash-command groups to ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`Failed publishing slash commands in ${guild.id}:`, error);
  }
}

// One compact home page and focused category tabs instead of one long command list.
const HELP_TABS = [
  ['list', 'Home'], ['members', 'Members'], ['staff', 'Staff'],
  ['setup', 'Setup'], ['info', 'About'],
];
function helpButtons(view = 'list') {
  return [new ActionRowBuilder().addComponents(...HELP_TABS.map(([id, label]) =>
    new ButtonBuilder().setCustomId(`pip:cmd:${id}`).setLabel(label)
      .setStyle(view === id ? ButtonStyle.Primary : ButtonStyle.Secondary)))];
}
function helpEmbed(view = 'list') {
  const embed = new EmbedBuilder().setColor(0x8b79db)
    .setFooter({ text: 'Pip • Use the buttons to change pages • /cmd list' });
  if (view === 'members') return embed
    .setTitle('🌱 Pip | Member Commands')
    .setDescription('Submit your own check in the designated activity-check channel.')
    .addFields(
      { name: '✅ Submit activity', value: '`/rpcheck` — Submit a check privately\n`!rpcheck` — Reacts ⏳ while processing, then ✅ when posted' },
      { name: '📖 Help and status', value: '`/cmd list` — Open Pip’s menu\n`/cmd info` — About Pip\n`/ping` — Check that Pip is online' },
      { name: 'Where is my report?', value: 'Full activity details go to your server’s **private staff audit channel**. Staff can open original-message links from there.' },
    );
  if (view === 'staff') return embed
    .setTitle('🛡️ Pip | Staff Tools')
    .setDescription('Review individual audits, member activity, and bot health.')
    .addFields(
      { name: '🔎 Member audits', value: '`/rplog member:@user` — Generate an audit with message links\n`/rplist` — View monitored RP locations' },
      { name: '📊 Activity chart', value: '`/rpchart view` — Everyone in the server, paged\n`/rpchart refresh` — Rescan recent activity\n`/rpchart post` — Update the staff dashboard\n`/rpchart sync` — Rebuild the member roster' },
      { name: '🎭 Tupperbox + diagnostics', value: '`/tupperdiagnose` — Verify Tupperbox logs\n`/rphealth` — Check stored settings and Railway volume' },
      { name: '⚙️ Server managers only', value: '`/rpadd` / `/rpremove` — Monitored sources\n`/rphours` — Audit window\n`/rplogchannel` / `/rpcheckchannel` — Destinations\n`/tupperlogchannel` — Ownership log\n`/rpchart sync` — Sync all existing members' },
    );
  if (view === 'setup') return embed
    .setTitle('⚙️ Pip | Setup Guide')
    .setDescription('Run these commands once as someone with **Manage Server** permission.')
    .addFields(
      { name: '1 · Staff reports', value: '`/rplogchannel channel:#rp-audit-logs`\nMake this channel visible to staff only.' },
      { name: '2 · Member check-ins', value: '`/rpcheckchannel channel:#activity-check`' },
      { name: '3 · Choose RP channels', value: '`/rpadd channel:#rp-chat`\n`/rpadd channel:#rp-forum`\nA forum includes its accessible posts; a text channel includes its public threads.' },
      { name: '4 · Set the window', value: '`/rphours hours:165` — Example: 165 hours\n`/rplist` — Verify what Pip monitors' },
      { name: '5 · Optional Tupperbox', value: 'Configure Tupperbox’s own log, then `/tupperlogchannel channel:#tupper-logs`.' },
      { name: '6 · Publish staff chart', value: '`/rpchart refresh` followed by `/rpchart post`' },
      { name: '💾 Railway', value: 'Attach a persistent Volume at `/data` to preserve settings across deployments. Check with `/rphealth`.' },
    );
  if (view === 'info') return embed
    .setTitle('🤖 Pip | About')
    .setDescription('RP activity checks for text channels, accessible forum posts and threads, with optional verified Tupperbox attribution.')
    .addFields(
      { name: '🔎 Original message links', value: 'Each audit is grouped by the places the member roleplayed, with clickable links for staff.' },
      { name: '📊 Two separate statuses', value: 'The chart automatically includes **all current human members**, even before they check in. It distinguishes **submitted an RP check** from **actually roleplayed**.' },
      { name: '🔒 Privacy', value: 'Staff audits remain in the designated private log channel. Do not give regular members access to staff-only reports.' },
      { name: '🎭 Crediting Tuppers', value: 'Pip only credits proxied RP messages when it can verify ownership from official Tupperbox logs.' },
    );
  return embed
    .setTitle('📚 Pip | Command Center')
    .setDescription('Your roleplay activity assistant. Pick a category below to see a **short, organized command list** instead of one crowded menu.')
    .addFields(
      { name: '🌱 Members', value: 'Submit activity with `/rpcheck` or `!rpcheck`.', inline: true },
      { name: '🛡️ Staff', value: 'Open RP audits, refresh charts, and review logs.', inline: true },
      { name: '⚙️ Setup', value: 'Manage monitored channels, time window, and Tupperbox.', inline: true },
      { name: 'Start here', value: '**Members:** `/rpcheck`\n**Staff:** `/rplog` or `/rpchart view`\n**Managers:** `/cmd setup`' },
    );
}


// =========================================================================
// 11 — DISCORD EVENT HANDLERS AND STARTUP
// =========================================================================
client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  // Start the member backfill without blocking command registration.
  await Promise.allSettled([...readyClient.guilds.cache.values()].map(registerGuildCommands));
  for (const guild of readyClient.guilds.cache.values()) {
    syncChartRoster(guild).catch(error => console.error(`Roster sync failed in ${guild.id}:`, error));
  }
});
client.on(Events.GuildCreate, guild => {
  registerGuildCommands(guild).catch(error => console.error('Command registration failed:', error));
  syncChartRoster(guild).catch(error => console.error(`Roster sync failed in ${guild.id}:`, error));
});
client.on(Events.GuildMemberAdd, member => memberJoinedChart(member));
client.on(Events.GuildMemberRemove, member => memberLeftChart(member));
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  // Only repaint after a display-name change, not every unrelated role update.
  if (oldMember.displayName !== newMember.displayName) scheduleDashboardUpdate(newMember.guild);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    // The help menu and the staff chart use Discord buttons instead of long walls of text.
    if (interaction.isButton() && interaction.customId.startsWith('pip:cmd:')) {
      const view = interaction.customId.split(':')[2];
      if (!HELP_TABS.some(([id]) => id === view)) return;
      return interaction.update({ embeds: [helpEmbed(view)], components: helpButtons(view) });
    }
    if (interaction.isButton() && interaction.customId.startsWith('pip:chart:')) {
      if (!interaction.guild || !isInteractionStaff(interaction)) {
        return interaction.reply({ content: 'This chart is for staff only.', flags: MessageFlags.Ephemeral });
      }
      const requested = Number(interaction.customId.split(':')[2]);
      if (!Number.isInteger(requested) || requested < 1) return;
      await interaction.deferUpdate();
      const result = await buildChartEmbed(interaction.guild, requested);
      return interaction.editReply({ embeds: [result.embed], components: chartPageButtons(result.page, result.totalPages) });
    }
    if (!interaction.isChatInputCommand() || !interaction.guild) return;
    const name = interaction.commandName;
    const cfg = settings(interaction.guild.id);

    if (name === 'cmd') {
      const view = interaction.options.getSubcommand();
      return interaction.reply({ embeds: [helpEmbed(view)], components: helpButtons(view), flags: MessageFlags.Ephemeral });
    }
    if (name === 'ping') {
      return respondPrivately(interaction, `🏓 Pip is online. Gateway ping: ${Math.max(0, Math.round(client.ws.ping))}ms.`);
    }
    if (name === 'rpcheck') {
      if (cfg.checkChannel && interaction.channelId !== cfg.checkChannel) {
        return respondPrivately(interaction, `Use <#${cfg.checkChannel}> to submit your RP check.`);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      enqueueAudit(slashAuditContext(interaction), interaction.user);
      return;
    }

    const staffCommands = ['rplog', 'rplist', 'rphealth', 'rpchart', 'rpadd', 'rpremove', 'rphours', 'rplogchannel', 'rpcheckchannel', 'tupperlogchannel', 'tupperdiagnose'];
    if (!staffCommands.includes(name)) return;
    if (!isInteractionStaff(interaction)) {
      return respondPrivately(interaction, 'This is a staff-only command.');
    }

    if (name === 'rpchart') {
      const action = interaction.options.getSubcommand();
      if (action === 'sync' && !isInteractionManager(interaction)) {
        return respondPrivately(interaction, 'You need **Manage Server** to sync the server roster.');
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (action === 'sync') {
        try {
          const result = await syncChartRoster(interaction.guild);
          return interaction.editReply({ content: `✅ Synced **${result.members} current server members** into the chart (bots excluded). New members will be added automatically when they join. Run **/rpchart view** to see the roster.`, allowedMentions: { parse: [] } });
        } catch (error) {
          console.error('Pip roster sync failed:', error);
          return interaction.editReply({ content: '⚠️ Could not sync members. Enable **Server Members Intent** in the Discord Developer Portal, then restart Pip on Railway and retry **/rpchart sync**.' });
        }
      }
      if (action === 'refresh') {
        // Bounded concurrency; scans no longer wait for someone else's report pages.
        const result = await withAuditSlot(() => refreshActivityChart(interaction.guild));
        let dashboardNote = '';
        if (chartSettings(interaction.guild.id).dashboard?.messageId) {
          try { await updateChartDashboard(interaction.guild); }
          catch (error) { console.error('Cannot update dashboard:', error); dashboardNote = '\n⚠️ Staff dashboard could not be updated.'; }
        }
        return interaction.editReply({ content: `✅ RP chart refreshed: **${result.members}** members with RP activity and **${result.messages}** messages found. ${result.warnings.length ? `⚠️ ${result.warnings.length} scan limitation(s); results may be incomplete.` : 'Scan completed.'}${dashboardNote}\nUse **/rpchart view** to inspect results.`, allowedMentions: { parse: [] } });
      }
      if (action === 'post') {
        const message = await updateChartDashboard(interaction.guild);
        return interaction.editReply({ content: `✅ Staff chart is available: ${message.url}\nIt updates after successful member RP checks. Run **/rpchart refresh** to rescan RP activity from everyone.`, allowedMentions: { parse: [] } });
      }
      const page = interaction.options.getInteger('page') || 1;
      const result = await buildChartEmbed(interaction.guild, page);
      return interaction.editReply({ embeds: [result.embed], components: chartPageButtons(result.page, result.totalPages), allowedMentions: { parse: [] } });
    }

    if (name === 'rplog') {
      const member = interaction.options.getUser('member', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      enqueueAudit(slashAuditContext(interaction), member);
      return;
    }
    if (name === 'tupperdiagnose') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { stats, warnings } = await getTupperOwners(
        interaction.guild, Date.now() - cfg.hours * 3600000, true
      );
      const state = !stats.logChannelConfigured ? 'Not configured — use /tupperlogchannel'
        : !stats.accessible ? 'Configured, but Pip cannot access it'
        : 'Readable';
      const description = [
        `**Log channel:** ${state}`,
        `**Messages inspected:** ${stats.inspected}`,
        `**Official Tupperbox log entries:** ${stats.officialLogMessages}`,
        `**Ownership entries matched:** ${stats.attributed}`,
        `**Unrecognized official entries:** ${stats.unparsedOfficial}`,
        `**Other authors:** ${stats.otherAuthors}`,
        stats.sampleFieldNames.length ? `**Observed embed field names:** ${stats.sampleFieldNames.map(x=>`\`${x}\``).join(', ')}` : '',
        warnings.length ? `**Issues:** ${warnings.join('; ')}` : '',
        '**Next test:** Send a new Tupper RP message in a monitored channel, then rerun this command and `/rpchart refresh`.',
      ].filter(Boolean).join('\n');
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x8b79db)
        .setTitle('🎭 Pip • Tupperbox Diagnostics')
        .setDescription(description.slice(0, 4000))], allowedMentions: { parse: [] } });
    }
    if (name === 'rplist') {
      const categorized = { text: [], forums: [], threads: [], missing: [] };
      for (const id of cfg.rpChannels) {
        const ch = await interaction.guild.channels.fetch(id).catch(() => null);
        const category = !ch ? 'missing'
          : ch.type === ChannelType.GuildForum ? 'forums'
          : ch.isThread?.() ? 'threads' : 'text';
        categorized[category].push(id);
      }
      const group = (ids, empty = 'None configured') => {
        if (!ids.length) return empty;
        const lines = ids.slice(0, 20).map(id => `• <#${id}>`);
        if (ids.length > 20) lines.push(`…and ${ids.length - 20} more`);
        return lines.join('\n');
      };
      const embed = new EmbedBuilder().setColor(0x8b79db)
        .setTitle('📚 Pip | Monitored RP Sources')
        .setDescription(`**${cfg.rpChannels.length} monitored sources** • **${cfg.hours}-hour** audit window\nOnly configured RP locations are scanned.`)
        .addFields(
          { name: `💬 Text channels (${categorized.text.length})`, value: group(categorized.text) },
          { name: `🗂️ Forums (${categorized.forums.length})`, value: group(categorized.forums) },
          { name: `🧵 Individual threads (${categorized.threads.length})`, value: group(categorized.threads) },
          ...(categorized.missing.length ? [{ name: '⚠️ Missing or inaccessible sources', value: group(categorized.missing) }] : []),
          { name: '📥 Staff report channel', value: cfg.logChannel ? `<#${cfg.logChannel}>` : 'Not configured', inline: true },
          { name: '✅ Check-in channel', value: cfg.checkChannel ? `<#${cfg.checkChannel}>` : 'Any channel', inline: true },
          { name: '🎭 Tupperbox ownership log', value: cfg.tupperLogChannel ? `<#${cfg.tupperLogChannel}>` : 'Not configured' },
        ).setFooter({ text: 'Pip • /rpadd and /rpremove change this list' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    if (name === 'rphealth') {
      const attached = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
      const embed = new EmbedBuilder().setColor(attached ? 0x3ba776 : 0xd6a140).setTitle('💾 Pip • Settings Health')
        .addFields(
          { name: 'Configuration path', value: `\`${truncate(CONFIG_PATH, 900)}\`` },
          { name: 'Chart data path', value: `\`${truncate(CHART_PATH, 900)}\`` },
          { name: 'Railway Volume', value: attached ? '✅ Attached' : '⚠️ Not detected — chart and settings may reset on redeploy', inline: true },
          { name: 'Sources configured', value: String(cfg.rpChannels.length), inline: true },
          { name: 'Audit window', value: `${cfg.hours} hours`, inline: true },
          { name: 'Tupperbox log', value: cfg.tupperLogChannel ? `<#${cfg.tupperLogChannel}>` : 'Not configured', inline: true },
          { name: 'Audit webhook mirror', value: mirrorWebhook && interaction.guild.id === AUDIT_WEBHOOK_GUILD_ID ? 'Configured in Railway' : 'Off', inline: true },
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    // Only users with Manage Server may change persistent configuration.
    if (!isInteractionManager(interaction)) {
      return respondPrivately(interaction, 'You need **Manage Server** to change Pip’s settings.');
    }
    if (name === 'tupperlogchannel') {
      const tupperChannel = interaction.options.getChannel('channel', true);
      if (!isSupportedChannel(tupperChannel)) return respondPrivately(interaction, 'Choose a normal private text channel for Tupperbox logs.');
      if (cfg.rpChannels.includes(tupperChannel.id)) return respondPrivately(interaction, 'Tupperbox logging must be separate from monitored RP channels.');
      if (tupperChannel.id === cfg.logChannel) return respondPrivately(interaction, 'Use a separate Tupperbox log channel, not Pip’s staff audit channel.');
      cfg.tupperLogChannel = tupperChannel.id;
      saveSettings();
      return respondPrivately(interaction, `✅ Pip will cross-reference official Tupperbox proxy logs in <#${tupperChannel.id}>. First enable logging in Tupperbox: \`tul!cfg log #tupper-logs\` (using your actual channel).`);
    }
    if (name === 'rphours') {
      const hours = interaction.options.getInteger('hours', true);
      cfg.hours = hours;
      saveSettings();
      return respondPrivately(interaction, `✅ RP audit window set to **${hours} hours**${hours === 168 ? ' (7 days)' : ''}.`);
    }
    let channel;
    if (name === 'rpadd' || name === 'rpremove') {
      const chosen = interaction.options.getChannel('channel');
      const threadId = interaction.options.getString('thread_id');
      if (chosen && threadId) return respondPrivately(interaction, 'Choose **either** a channel **or** a thread ID, not both.');
      if (!chosen && !threadId) return respondPrivately(interaction, 'Choose a channel/forum or enter a thread ID.');
      if (threadId && !/^\d{17,22}$/.test(threadId)) return respondPrivately(interaction, 'That thread ID is not valid. Enable Developer Mode and copy the thread ID.');
      channel = chosen || await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (!isSupportedMonitorChannel(channel)) return respondPrivately(interaction, 'That source must be a text channel, forum, or accessible thread.');
      if (name === 'rpadd') {
        if (channel.id === cfg.logChannel || channel.id === cfg.tupperLogChannel) return respondPrivately(interaction, 'You cannot monitor a staff audit or Tupperbox log channel as RP.');
        if (cfg.rpChannels.includes(channel.id)) return respondPrivately(interaction, 'That source is already monitored.');
        cfg.rpChannels.push(channel.id);
        saveSettings();
        return respondPrivately(interaction, `✅ Added <#${channel.id}> to RP monitoring.`);
      }
      if (!cfg.rpChannels.includes(channel.id)) return respondPrivately(interaction, 'That source is not in the monitored list.');
      cfg.rpChannels = cfg.rpChannels.filter(id => id !== channel.id);
      saveSettings();
      return respondPrivately(interaction, `✅ Removed <#${channel.id}> from RP monitoring.`);
    }
    channel = interaction.options.getChannel('channel', true);
    if (!isSupportedChannel(channel)) return respondPrivately(interaction, 'Select a normal text channel (not a forum or thread).');
    if (name === 'rplogchannel') {
      if (cfg.rpChannels.includes(channel.id)) return respondPrivately(interaction, 'Choose a staff log channel outside the monitored RP channels.');
      cfg.logChannel = channel.id;
      saveSettings();
      return respondPrivately(interaction, `✅ Staff audits will be posted to <#${channel.id}>. Keep this channel private.`);
    }
    if (name === 'rpcheckchannel') {
      cfg.checkChannel = channel.id;
      saveSettings();
      return respondPrivately(interaction, `✅ Members may now use /rpcheck or !rpcheck in <#${channel.id}>.`);
    }
  } catch (error) {
    console.error('Slash-command error:', error);
    if (interaction.isRepliable()) {
      await respondPrivately(interaction, 'Pip ran into an error. Check Railway Deploy Logs and Discord permissions.').catch(() => {});
    }
  }
});

// The ONLY supported prefix command is !rpcheck. Everything else uses `/`.
client.on(Events.MessageCreate, async message => {
  if (!message.guild) return;
  invalidateChannelCache(message.channelId);
  if (message.channelId === settings(message.guild.id).tupperLogChannel) {
    tupperOwnerCache.delete(message.guild.id);
    // A new ownership log can reattribute messages already present in recent scans.
    channelScanCache.clear();
  }
  if (message.author.bot || message.content.trim().toLowerCase() !== '!rpcheck') return;
  try {
    const cfg = settings(message.guild.id);
    if (cfg.checkChannel && message.channelId !== cfg.checkChannel) {
      return reply(message, `Use <#${cfg.checkChannel}> to submit your RP check.`);
    }
    // Show that Pip received the check immediately, even if a long scan is queued.
    // ✅ is still reserved for a successfully published staff audit.
    await message.react('⏳').catch(() => {});
    enqueueAudit(message, message.author);
  } catch (error) {
    console.error('!rpcheck failed:', error);
    await reply(message, 'Pip could not process the RP check.').catch(() => {});
  }
});

client.on(Events.MessageDelete, message => {
  invalidateChannelCache(message.channelId);
  if (message.guild && message.channelId === settings(message.guild.id).tupperLogChannel) {
    tupperOwnerCache.delete(message.guild.id);
    channelScanCache.clear();
  }
});
client.on(Events.MessageUpdate, (_oldMessage, message) => {
  invalidateChannelCache(message.channelId);
});

client.login(TOKEN);
