/**
 * Pip v1.6.1 - discord.js 14
 * Members use !rpcheck or /rpcheck in the configured check channel. All other commands use /.
 * The bot audits recent messages in configured RP text, thread, and forum channels, sends a staff log,
 * and reacts ✅ once the report has been sent.
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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
      .addIntegerOption(p => p.setName('page').setDescription('Chart page (15 members per page)').setMinValue(1).setRequired(false)))
    .addSubcommand(o => o.setName('refresh').setDescription('Scan monitored RP sources and refresh the chart.'))
    .addSubcommand(o => o.setName('post').setDescription('Post or update the chart in the private staff log.'))
    .addSubcommand(o => o.setName('track').setDescription('Include a member on the chart even if they have no activity.')
      .addUserOption(p => p.setName('member').setDescription('Server member to track').setRequired(true)))
    .addSubcommand(o => o.setName('untrack').setDescription('Stop manually tracking a member on the chart.')
      .addUserOption(p => p.setName('member').setDescription('Member to stop tracking').setRequired(true))),
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

function helpButtons(view = 'list') {
  const tabs = [
    ['list', 'All commands'], ['info', 'About Pip'], ['setup', 'Setup guide'],
  ];
  return [new ActionRowBuilder().addComponents(...tabs.map(([id, label]) =>
    new ButtonBuilder().setCustomId(`pip:cmd:${id}`).setLabel(label)
      .setStyle(view === id ? ButtonStyle.Primary : ButtonStyle.Secondary)))];
}

function helpEmbed(view = 'list') {
  const embed = new EmbedBuilder().setColor(0x8b79db).setFooter({ text: 'Pip • RP activity audits • /cmd list' });
  if (view === 'info') {
    return embed.setTitle('🤖 About Pip')
      .setDescription('Pip checks RP activity across configured text channels, public threads, and accessible forum posts. Audit reports are sent to a designated private staff channel.')
      .addFields(
        { name: '🔎 Message-level auditing', value: 'Reports group activity by channel/post and link directly to each original message. Pip only counts accessible activity inside the selected time window.' },
        { name: '✅ Activity check', value: '`/rpcheck` confirms privately. The only `!` command, `!rpcheck`, reacts ✅ when the audit is posted.' },
        { name: '🔐 Access', value: 'Members can submit checks. Staff can review audits. Server managers control the bot’s configuration.' },
        { name: '📚 Explore commands', value: 'Select **All commands** or **Setup guide** below.' },
      );
  }
  if (view === 'setup') {
    return embed.setTitle('🛠️ Pip • Quick Setup')
      .setDescription('Use these commands in your Discord server. You must have **Manage Server** permission to configure Pip.')
      .addFields(
        { name: '1 • Private log', value: '`/rplogchannel channel:#rp-audit-logs`\nRestrict that channel to your staff.' },
        { name: '2 • Check-in channel', value: '`/rpcheckchannel channel:#activity-check`' },
        { name: '3 • Add RP sources', value: '`/rpadd channel:#roleplay-forum`\n`/rpadd channel:#roleplay-chat`\nOr use `thread_id` for a specific thread.' },
        { name: '4 • Set audit window', value: '`/rphours hours:168` — 7 days' },
        { name: '5 • Verify and test', value: '`/rplist` · `/rphealth` · `/rpcheck`' },
        { name: '6 • Member chart', value: '`/rpchart refresh` scans all monitored RP sources. `/rpchart view` shows check-ins vs RP activity; `/rpchart post` maintains a staff-only dashboard. Use `/rpchart track` to include members with neither.' },
        { name: '7 • Tupperbox RP', value: 'First run `tul!cfg log #tupper-logs` with Tupperbox, then `/tupperlogchannel channel:#tupper-logs` with Pip. Pip credits only proxy messages verified against the official log.' },
        { name: 'Important for Railway', value: 'Attach a persistent Volume mounted at `/data` so RP channel settings survive redeploys.' },
      );
  }
  return embed.setTitle('📚 Pip • Command Directory')
    .setDescription('Use slash commands for setup, staff tools, and reports. The only remaining `!` command is **`!rpcheck`**.')
    .addFields(
      { name: '🌱 Members', value: '`/rpcheck` or `!rpcheck` — Submit your own RP activity check\n`/cmd list` — Show this help menu\n`/cmd info` — About Pip\n`/ping` — Check whether Pip is online' },
      { name: '🛡️ Staff', value: '`/rplog member:@user` — Audit a member\n`/rpchart view` — Check-ins vs RP chart\n`/rpchart refresh` — Rescan recent activity\n`/rpchart post` — Update staff dashboard\n`/rplist` — View monitored sources\n`/rphealth` — Check persistent storage' },
      { name: '⚙️ Server managers', value: '`/rpadd` — Add a channel, forum, or thread\n`/rpremove` — Remove monitored source\n`/rphours` — Set audit hours\n`/rplogchannel` — Set staff audit destination\n`/rpcheckchannel` — Set check-in channel\n`/tupperlogchannel` — Set official Tupperbox log source\n`/tupperdiagnose` — Diagnose log matching\n`/rpchart track` / `/rpchart untrack` — Manage chart roster' },
      { name: '💡 Setup walkthrough', value: 'Use `/cmd setup` or select the **Setup guide** button below.' },
    );
}

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
  chart.trackedIds ||= [];
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
  const now = Date.now();
  chart.checks[userId] ||= [];
  chart.checks[userId].push(now);
  chart.activity[userId] = { count: messageCount, scannedAt: now, hours: settings(guildId).hours };
  saveChart();
}

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
  const { owners, warnings } = await getTupperOwners(guild, cutoff);
  for (const id of cfg.rpChannels) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!isSupportedMonitorChannel(channel)) {
      warnings.push(`Monitored source ${id} is missing or unsupported`);
      continue;
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
        const own = await scanChannel(channel, null, cutoff, owners);
        const children = await scanChildThreads(channel, null, cutoff, owners);
        [...own.matches, ...children.matches].forEach(m => uniqueMessages.set(m.id, m));
        if (own.truncated) warnings.push(`${channel.name}: scan limit reached`);
        warnings.push(...children.warnings);
      }
    } catch (error) {
      console.error(`Cannot refresh chart for ${id}`, error);
      warnings.push(`${channel.name}: messages inaccessible`);
    }
  }
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

const CHART_PAGE_SIZE = 15;
async function buildChartEmbed(guild, pageNumber = 1) {
  const cfg = settings(guild.id);
  const chart = chartSettings(guild.id);
  const cutoff = Date.now() - cfg.hours * 3600000;
  const checkers = new Set(Object.entries(chart.checks)
    .filter(([, history]) => Array.isArray(history) && history.some(t => t >= cutoff))
    .map(([id]) => id));
  const ids = new Set([
    ...chart.trackedIds,
    ...checkers,
    ...Object.entries(chart.activity).filter(([, a]) => a?.count > 0 && a.hours === cfg.hours && a.scannedAt >= cutoff).map(([id]) => id),
  ]);
  // A specific user may have a recent on-demand audit even before a full refresh.
  const hasFreshScan = Boolean(chart.lastRefreshedAt && chart.refreshedForHours === cfg.hours && chart.lastRefreshedAt >= cutoff);
  const rows = [...ids].map(id => {
    const recentScan = chart.activity[id]?.hours === cfg.hours && chart.activity[id]?.scannedAt >= cutoff ? chart.activity[id] : null;
    const rpCount = recentScan?.count ?? (hasFreshScan ? 0 : null);
    return { id, checked: checkers.has(id), rpCount, scanAt: recentScan?.scannedAt || 0 };
  }).sort((a, b) => Number(b.checked) - Number(a.checked) ||
    Number(b.rpCount > 0) - Number(a.rpCount > 0) || b.rpCount - a.rpCount || a.id.localeCompare(b.id));
  const totalPages = Math.max(1, Math.ceil(rows.length / CHART_PAGE_SIZE));
  const page = Math.min(Math.max(1, pageNumber), totalPages);
  const items = rows.slice((page - 1) * CHART_PAGE_SIZE, page * CHART_PAGE_SIZE);
  const names = await Promise.all(items.map(item => getLiveServerName(guild, item.id)));
  const lines = items.map((item, i) => {
    const check = item.checked ? '✅' : '—';
    const played = item.rpCount === null ? '❔' : item.rpCount > 0 ? '✅' : '—';
    const quantity = item.rpCount > 0 ? ` · ${item.rpCount} messages` : '';
    return `${check}  ${played}  **${names[i]}**${quantity}`;
  });
  const checkedCount = rows.filter(r => r.checked).length;
  const activeCount = rows.filter(r => r.rpCount > 0).length;
  const refreshLine = hasFreshScan
    ? `<t:${Math.floor(chart.lastRefreshedAt / 1000)}:f> (as-of snapshot)`
    : 'Not refreshed for this audit window — use `/rpchart refresh`';
  const embed = new EmbedBuilder().setColor(0x8b79db)
    .setTitle('📊 Pip • RP Check-In & Activity Chart')
    .setDescription([
      `**Period:** Last ${cfg.hours} hours`,
      `**Checked in:** ${checkedCount}   •   **RP observed:** ${activeCount}   •   **Listed:** ${rows.length}`,
      `**RP scan:** ${refreshLine}`,
      '',
      '**Check-in  RP  —  Current in-server name**',
      ...(lines.length ? lines : ['No entries yet. Run `/rpchart refresh` or `/rpchart track`.']),
    ].join('\n'))
    .addFields({ name: 'How it works', value: '✅ = yes · — = no · ❔ = not scanned. Check-in means `/rpcheck` or `!rpcheck` successfully posted an audit. Staff `/rplog` does **not** count as a check-in.' })
    .setFooter({ text: `Page ${page}/${totalPages} • Pip tracks Discord IDs, so nicknames are looked up when rendered` });
  if (hasFreshScan && chart.warnings.length) {
    embed.addFields({ name: '⚠️ Scan limitations', value: `Some sources were incomplete (${chart.warnings.length} issue(s)). Results may undercount RP.` });
  }
  if (!chart.trackedIds.length) {
    embed.addFields({ name: 'Who appears?', value: 'Members with a recorded check-in or observed RP activity. Use `/rpchart track` for members with neither. Pip does not automatically enumerate every server member.' });
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
async function getTupperOwners(guild, cutoff, diagnostic = false) {
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

async function sendAuditToStaff(logChannel, payload, guildId) {
  const posted = await logChannel.send(payload);
  if (mirrorWebhook && guildId === AUDIT_WEBHOOK_GUILD_ID) {
    try {
      // Mirror the same summary and direct-message links to a second staff-only
      // channel. Webhook URL is a secret stored in Railway Variables, not Discord.
      await mirrorWebhook.send({ ...payload, username: 'Pip RP Audit', allowedMentions: { parse: [] } });
    } catch (error) {
      console.error('Could not mirror staff audit to the configured webhook:', error);
    }
  }
  return posted;
}

// Read a configurable time window, paging backward until before the cutoff.
async function scanChannel(channel, userId, cutoff, owners = new Map()) {
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
  for (const thread of threads) {
    try {
      const result = await scanChannel(thread, userId, cutoff, owners);
      searchedThreads++;
      matches.push(...result.matches);
      if (result.truncated) warnings.push(`#${parent.name} / ${thread.name}: reached 5,000-message cap`);
    } catch (error) {
      console.error(`Cannot read thread ${thread.id}:`, error);
      warnings.push(`#${parent.name} / ${thread.name}: could not read messages`);
    }
  }
  return { matches, warnings, searchedThreads };
}

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

async function runAudit(originMessage, targetUser) {
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
  const { owners, warnings } = await getTupperOwners(originMessage.guild, cutoff);
  let scannedSources = 0;
  let scannedPosts = 0;

  for (const channelId of cfg.rpChannels) {
    const channel = await originMessage.guild.channels.fetch(channelId).catch(() => null);
    if (!isSupportedMonitorChannel(channel)) {
      warnings.push(`Channel ID ${channelId}: missing or unsupported`);
      continue;
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
        const own = await scanChannel(channel, targetUser.id, cutoff, owners);
        const child = await scanChildThreads(channel, targetUser.id, cutoff, owners);
        scannedPosts += child.searchedThreads;
        for (const m of [...own.matches, ...child.matches]) foundById.set(m.id, m);
        if (own.truncated) warnings.push(`${channel.name}: reached 5,000-message scan limit`);
        warnings.push(...child.warnings);
      }
    } catch (error) {
      console.error(`Cannot audit channel ${channelId}:`, error);
      warnings.push(`${channel.name}: could not read message history`);
    }
  }

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

  const status = warnings.length ? '⚠️ Partial scan — see notes' : '✅ Scan completed';
  const summaryEmbed = new EmbedBuilder()
    .setColor(warnings.length ? 0xe8a23a : 0x667eea)
    .setTitle(`📋 RP Activity Audit — ${truncate(liveName, 100)}`)
    .setDescription([
      `**Member:** ${liveName} (\`${targetUser.id}\`)`,
      `**Requested by:** ${originMessage.author.username}`,
      `**Period:** Last ${cfg.hours} hours`,
      `**Messages found:** **${found.length}**`,
      `**Verified Tupper messages:** **${[...characters.values()].reduce((n, x) => n + x, 0)}**`,
      `**Locations with activity:** **${locations.length}**`,
      `**Status:** ${status}`,
      `**Generated:** <t:${time}:f>`,
    ].join('\n'))
    .setFooter({ text: `Pip • ${scannedSources} configured sources checked${scannedPosts ? ` • ${scannedPosts} accessible threads/posts inspected` : ''}` });

  if (characters.size) {
    const charLines = [...characters.entries()].sort((a,b) => b[1] - a[1]).map(([n,c]) => `• **${c}** — ${truncate(n, 60)}`);
    summaryEmbed.addFields({ name: '🎭 Tupper characters credited to this member', value: truncate(charLines.join('\n'), 990) });
  }

  if (locations.length) {
    // 1024-character embed field limit. Split summaries into readable lines.
    let groupText = '';
    let fieldNo = 1;
    let omitted = 0;
    for (const entry of locations) {
      const label = truncate(getLocationLabel(entry.channel), 90).replace(/[\r\n]/g, ' ');
      const line = `• **${entry.messages.length}** — ${label}\n`;
      if (groupText.length + line.length > 950) {
        if (fieldNo <= 4) summaryEmbed.addFields({ name: fieldNo === 1 ? 'Active locations' : 'Active locations (continued)', value: groupText });
        else omitted += 1;
        fieldNo++;
        groupText = '';
      }
      groupText += line;
    }
    if (groupText) {
      if (fieldNo <= 4) summaryEmbed.addFields({ name: fieldNo === 1 ? 'Active locations' : 'Active locations (continued)', value: groupText });
      else omitted++;
    }
    if (omitted) summaryEmbed.addFields({ name: 'More active locations', value: 'See the detailed audit messages below.' });
  } else {
    summaryEmbed.addFields({ name: 'Result', value: 'No RP messages found during the selected window.' });
  }

  if (warnings.length) {
    summaryEmbed.addFields({ name: 'Scan notes', value: truncate(warnings.map(w => `• ${w}`).join('\n'), 900) });
  }

  // Searchable plain-text heading and visually organized summary embed.
  await sendAuditToStaff(logChannel, {
    content: `${searchableTag}\n${linkToCheck}`,
    embeds: [summaryEmbed],
    allowedMentions: { parse: [] },
  }, originMessage.guild.id);

  // Message records grouped by actual post/thread/channel. Each original link
  // opens directly on the member's individual message in Discord.
  for (const location of locations) {
    const place = getLocationLabel(location.channel);
    const header = `${searchableTag}\n📍 **${truncate(place, 130)}** — ${location.messages.length} message(s)\n`;
    const lines = location.messages.map(m => {
      const stamp = Math.floor(m.createdTimestamp / 1000);
      const link = m.url || `https://discord.com/channels/${originMessage.guild.id}/${m.channelId}/${m.id}`;
      const actor = m._pipTupperName ? `🎭 **${truncate(m._pipTupperName, 75)}** — ` : '';
      return `${actor}**<t:${stamp}:f>** — ${cleanContent(m)}\n🔗 ${link}\n`;
    });
    const pages = paginateDetails(header, lines);
    for (let i = 0; i < pages.length; i++) {
      // Multi-page records repeat the place + member ID for staff search.
      const suffix = pages.length > 1 ? `\n*${i + 1}/${pages.length} pages for this location*` : '';
      await sendAuditToStaff(logChannel, { content: `${pages[i]}${suffix}`, allowedMentions: { parse: [] } }, originMessage.guild.id);
    }
  }

  // Only a member's own successful !rpcheck or /rpcheck counts as a check-in.
  // Staff /rplog audits never count as submitted checks.
  const isSelfCheck = originMessage._interaction
    ? originMessage.commandName === 'rpcheck'
    : originMessage.content.trim().toLowerCase() === '!rpcheck';
  if (isSelfCheck) {
    try {
      recordCheckIn(originMessage.guild.id, targetUser.id, found.length);
      const chart = chartSettings(originMessage.guild.id);
      if (chart.dashboard?.messageId) await updateChartDashboard(originMessage.guild);
    } catch (error) {
      console.error('Could not save/update check-in chart:', error);
    }
  }

  // Slash commands have no ordinary user message to react to. Confirm them
  // privately; retain ✅ on the original message for !rpcheck.
  if (originMessage._interaction) {
    await reply(originMessage, `✅ RP audit posted to <#${cfg.logChannel}>. Found **${found.length}** message(s) across **${locations.length}** active location(s).`);
  } else {
    await originMessage.react('✅');
    if (originMessage.content.trim().toLowerCase() !== '!rpcheck') {
      await reply(originMessage, `Audit posted in <#${cfg.logChannel}> (${found.length} message(s) across ${locations.length} active location(s)).`);
    }
  }
}

// Serialize audits so multi-page reports from different users don't mix.
let auditQueue = Promise.resolve();
function enqueueAudit(message, user) {
  const task = auditQueue.then(() => runAudit(message, user));
  auditQueue = task.catch(() => {});
  task.catch(async err => {
    console.error('RP audit failed:', err);
    await reply(message, 'Could not finish the audit. Check bot permissions and the console.').catch(() => {});
  });
  return task;
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await Promise.allSettled([...readyClient.guilds.cache.values()].map(registerGuildCommands));
});
client.on(Events.GuildCreate, registerGuildCommands);

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Navigation controls on /cmd list; visible only to the member who opened it.
    if (interaction.isButton() && interaction.customId.startsWith('pip:cmd:')) {
      const view = interaction.customId.split(':')[2];
      if (!['list', 'info', 'setup'].includes(view)) return;
      return interaction.update({ embeds: [helpEmbed(view)], components: helpButtons(view) });
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
      if (action === 'track' || action === 'untrack') {
        if (!isInteractionManager(interaction)) return respondPrivately(interaction, 'You need **Manage Server** to change the chart roster.');
        const member = interaction.options.getUser('member', true);
        const chart = chartSettings(interaction.guild.id);
        if (action === 'track') {
          const inServer = await interaction.guild.members.fetch({ user: member.id, force: true }).catch(() => null);
          if (!inServer) return respondPrivately(interaction, 'That member is not in this server.');
          if (!chart.trackedIds.includes(member.id)) chart.trackedIds.push(member.id);
        } else {
          chart.trackedIds = chart.trackedIds.filter(id => id !== member.id);
        }
        saveChart();
        return respondPrivately(interaction, action === 'track'
          ? `✅ Added ${member.username} to the chart roster. Their current server nickname will be shown when viewed.`
          : `✅ Removed the manual roster entry for ${member.username}. Existing RP activity and check-in records will still be included until they fall outside the time window.`);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (action === 'refresh') {
        // Don't let the complete-source scan interleave with long multi-page staff audits.
        const job = auditQueue.then(() => refreshActivityChart(interaction.guild));
        auditQueue = job.catch(() => {});
        const result = await job;
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
      return interaction.editReply({ embeds: [result.embed], allowedMentions: { parse: [] } });
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
      const sources = cfg.rpChannels.length ? cfg.rpChannels.map(id => `• <#${id}>`).join('\n') : 'None configured yet.';
      // Embed descriptions max out at 4,096 characters; avoid giant source lists.
      const safeSources = truncate(sources, 3300);
      const embed = new EmbedBuilder().setColor(0x8b79db).setTitle('📚 Pip • Monitored RP Sources')
        .setDescription(safeSources)
        .addFields(
          { name: '📁 Staff log', value: cfg.logChannel ? `<#${cfg.logChannel}>` : 'Not set', inline: true },
          { name: '✅ Check-in channel', value: cfg.checkChannel ? `<#${cfg.checkChannel}>` : 'Any channel', inline: true },
          { name: '🕐 Audit window', value: `${cfg.hours} hours`, inline: true },
          { name: '🎭 Tupperbox ownership log', value: cfg.tupperLogChannel ? `<#${cfg.tupperLogChannel}>` : 'Not set — Tupper messages cannot be automatically credited', inline: false },
        )
        .setFooter({ text: `${cfg.rpChannels.length} monitored source(s) • Pip` });
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
  if (!message.guild || message.author.bot || message.content.trim().toLowerCase() !== '!rpcheck') return;
  try {
    const cfg = settings(message.guild.id);
    if (cfg.checkChannel && message.channelId !== cfg.checkChannel) {
      return reply(message, `Use <#${cfg.checkChannel}> to submit your RP check.`);
    }
    enqueueAudit(message, message.author);
  } catch (error) {
    console.error('!rpcheck failed:', error);
    await reply(message, 'Pip could not process the RP check.').catch(() => {});
  }
});

client.login(TOKEN);
