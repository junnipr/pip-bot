/**
 * RP Check Bot - discord.js 14
 * Members use !rpcheck or /rpcheck in the configured check channel.
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
const LEGACY_CONFIG_PATH = path.join(__dirname, 'rpcheck-config.json');
const MAX_PAGES_PER_CHANNEL = 50; // 5,000 recent messages per text channel or forum post
const MAX_THREADS_PER_PARENT = 300;
const MAX_ARCHIVED_THREAD_PAGES = 5;

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
  new SlashCommandBuilder().setName('cmd').setDescription('Open Pip’s interactive command directory.')
    .addSubcommand(o => o.setName('list').setDescription('View the complete command directory.'))
    .addSubcommand(o => o.setName('info').setDescription('Learn about Pip and its audit reports.'))
    .addSubcommand(o => o.setName('setup').setDescription('Read the server setup guide.')),
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
        { name: '✅ Two command styles', value: '`/rpcheck` confirms privately when finished. The original `!rpcheck` still reacts ✅ to the member’s message after posting the audit.' },
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
        { name: 'Important for Railway', value: 'Attach a persistent Volume mounted at `/data` so RP channel settings survive redeploys.' },
      );
  }
  return embed.setTitle('📚 Pip • Command Directory')
    .setDescription('Use `/` to pick a command. Choose a section below for more information. **Existing `!` commands still work.**')
    .addFields(
      { name: '🌱 Members', value: '`/rpcheck` — Submit your own RP activity check\n`/cmd list` — Show this help menu\n`/cmd info` — About Pip\n`/ping` — Check whether Pip is online' },
      { name: '🛡️ Staff', value: '`/rplog member:@user` — Audit a member\n`/rplist` — View monitored sources\n`/rphealth` — Check persistent storage' },
      { name: '⚙️ Server managers', value: '`/rpadd` — Add a channel, forum, or thread\n`/rpremove` — Remove monitored source\n`/rphours` — Set audit hours\n`/rplogchannel` — Set staff audit destination\n`/rpcheckchannel` — Set check-in channel' },
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
    db[guildId] = { rpChannels: [], logChannel: null, checkChannel: null, hours: 48 };
  }
  return db[guildId];
}

function saveSettings() {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function isManager(message) {
  return message.guild.ownerId === message.author.id ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function isStaff(message) {
  return isManager(message) ||
    [...STAFF_ROLE_IDS].some(id => message.member.roles.cache.has(id));
}

async function parseChannel(message, input) {
  const id = input?.match(/^<#(\d+)>$|^(\d+)$/)?.slice(1).find(Boolean);
  return id ? message.guild.channels.fetch(id).catch(() => null) : null;
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

// Read a configurable time window, paging backward until before the cutoff.
async function scanChannel(channel, userId, cutoff) {
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
      if (m.author.id === userId && !m.author.bot) {
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

async function scanChildThreads(parent, userId, cutoff) {
  const { threads, warnings } = await collectPublicThreads(parent, cutoff);
  const matches = [];
  let searchedThreads = 0;
  for (const thread of threads) {
    try {
      const result = await scanChannel(thread, userId, cutoff);
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
    return reply(originMessage, 'RP check is not configured yet. Staff: use `!rplogchannel #channel` and `!rpadd #channel`.');
  }

  const logChannel = await originMessage.guild.channels.fetch(cfg.logChannel).catch(() => null);
  if (!logChannel?.isTextBased() || !logChannel.send) {
    return reply(originMessage, 'The staff log channel is missing or inaccessible. Ask staff to set `!rplogchannel #channel`.');
  }

  const cutoff = Date.now() - cfg.hours * 60 * 60 * 1000;
  const foundById = new Map(); // avoids duplicate results when both a parent and its thread are configured
  const warnings = [];
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
        const result = await scanChildThreads(channel, targetUser.id, cutoff);
        scannedPosts += result.searchedThreads;
        for (const m of result.matches) foundById.set(m.id, m);
        warnings.push(...result.warnings);
      } else if (channel.isThread()) {
        const result = await scanChannel(channel, targetUser.id, cutoff);
        for (const m of result.matches) foundById.set(m.id, m);
        if (result.truncated) warnings.push(`${channel.name}: reached 5,000-message scan limit`);
      } else {
        const own = await scanChannel(channel, targetUser.id, cutoff);
        const child = await scanChildThreads(channel, targetUser.id, cutoff);
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
  const time = Math.floor(Date.now() / 1000);
  const searchableTag = `RP AUDIT | ${targetUser.username} | USER ID: ${targetUser.id}`;
  const linkToCheck = originMessage.url
    ? `Source check: ${originMessage.url}`
    : `Requested with /${originMessage.commandName} in <#${originMessage.channelId}>`;

  const status = warnings.length ? '⚠️ Partial scan — see notes' : '✅ Scan completed';
  const summaryEmbed = new EmbedBuilder()
    .setColor(warnings.length ? 0xe8a23a : 0x667eea)
    .setTitle(`📋 RP Activity Audit — ${truncate(targetUser.username, 100)}`)
    .setDescription([
      `**Member:** ${targetUser.username} (\`${targetUser.id}\`)`,
      `**Requested by:** ${originMessage.author.username}`,
      `**Period:** Last ${cfg.hours} hours`,
      `**Messages found:** **${found.length}**`,
      `**Locations with activity:** **${locations.length}**`,
      `**Status:** ${status}`,
      `**Generated:** <t:${time}:f>`,
    ].join('\n'))
    .setFooter({ text: `Pip • ${scannedSources} configured sources checked${scannedPosts ? ` • ${scannedPosts} accessible threads/posts inspected` : ''}` });

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
  await logChannel.send({
    content: `${searchableTag}\n${linkToCheck}`,
    embeds: [summaryEmbed],
    allowedMentions: { parse: [] },
  });

  // Message records grouped by actual post/thread/channel. Each original link
  // opens directly on the member's individual message in Discord.
  for (const location of locations) {
    const place = getLocationLabel(location.channel);
    const header = `${searchableTag}\n📍 **${truncate(place, 130)}** — ${location.messages.length} message(s)\n`;
    const lines = location.messages.map(m => {
      const stamp = Math.floor(m.createdTimestamp / 1000);
      const link = m.url || `https://discord.com/channels/${originMessage.guild.id}/${m.channelId}/${m.id}`;
      return `**<t:${stamp}:f>** — ${cleanContent(m)}\n🔗 ${link}\n`;
    });
    const pages = paginateDetails(header, lines);
    for (let i = 0; i < pages.length; i++) {
      // Multi-page records repeat the place + member ID for staff search.
      const suffix = pages.length > 1 ? `\n*${i + 1}/${pages.length} pages for this location*` : '';
      await logChannel.send({ content: `${pages[i]}${suffix}`, allowedMentions: { parse: [] } });
    }
  }

  // Slash commands have no ordinary user message to react to. Confirm them
  // privately; retain ✅ on the original message for the legacy !rpcheck command.
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

    const staffCommands = ['rplog', 'rplist', 'rphealth', 'rpadd', 'rpremove', 'rphours', 'rplogchannel', 'rpcheckchannel'];
    if (!staffCommands.includes(name)) return;
    if (!isInteractionStaff(interaction)) {
      return respondPrivately(interaction, 'This is a staff-only command.');
    }

    if (name === 'rplog') {
      const member = interaction.options.getUser('member', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      enqueueAudit(slashAuditContext(interaction), member);
      return;
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
        )
        .setFooter({ text: `${cfg.rpChannels.length} monitored source(s) • Pip` });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    if (name === 'rphealth') {
      const attached = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
      const embed = new EmbedBuilder().setColor(attached ? 0x3ba776 : 0xd6a140).setTitle('💾 Pip • Settings Health')
        .addFields(
          { name: 'Configuration path', value: `\`${truncate(CONFIG_PATH, 900)}\`` },
          { name: 'Railway Volume', value: attached ? '✅ Attached' : '⚠️ Not detected', inline: true },
          { name: 'Sources configured', value: String(cfg.rpChannels.length), inline: true },
          { name: 'Audit window', value: `${cfg.hours} hours`, inline: true },
        );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    // Only users with Manage Server may change persistent configuration.
    if (!isInteractionManager(interaction)) {
      return respondPrivately(interaction, 'You need **Manage Server** to change Pip’s settings.');
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
        if (channel.id === cfg.logChannel) return respondPrivately(interaction, 'You cannot monitor the staff audit log channel.');
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

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith('!')) return;
  const [commandRaw, ...args] = message.content.trim().split(/\s+/);
  const command = commandRaw.toLowerCase();
  const cfg = settings(message.guild.id);

  try {
    if (command === '!rpcheck') {
      if (args.length) return; // Only !rpcheck, not !rpcheck @someone
      if (cfg.checkChannel && message.channel.id !== cfg.checkChannel) {
        return reply(message, `Use <#${cfg.checkChannel}> to submit your RP check.`);
      }
      enqueueAudit(message, message.author);
      return;
    }

    if (command === '!cmd' || command === '!help') {
      return message.reply({ embeds: [helpEmbed('list')], allowedMentions: { repliedUser: false, parse: [] } });
    }

    // The commands below are restricted to staff; configure STAFF_ROLE_IDS
    // or grant staff Manage Server permission in Discord.
    if (!['!rpadd', '!rpremove', '!rplist', '!rplogchannel', '!rpcheckchannel', '!rphours', '!rplog', '!rphealth'].includes(command)) return;
    if (!isStaff(message)) return reply(message, 'This is a staff-only command.');

    if (command === '!rplist') {
      return reply(message,
        `**Monitored RP channels / forums / threads:**\n${cfg.rpChannels.map(id => `• <#${id}>`).join('\n') || '(none)'}\n` +
        `Staff log: ${cfg.logChannel ? `<#${cfg.logChannel}>` : '(not set)'}\n` +
        `Check channel: ${cfg.checkChannel ? `<#${cfg.checkChannel}>` : '(any channel until set)'}\n` +
        `Audit window: ${cfg.hours} hours.`
      );
    }

    if (command === '!rphealth') {
      return reply(message, `**Pip settings storage**\nPath: \`${CONFIG_PATH}\`\nRailway volume attached: **${Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH) ? 'yes' : 'no'}**\nConfigured RP sources: ${cfg.rpChannels.length}`);
    }

    if (command === '!rplog') {
      const id = args[0]?.match(/^<@!?(\d+)>$|^(\d+)$/)?.slice(1).find(Boolean);
      if (!id) return reply(message, 'Usage: `!rplog @member` or `!rplog USER_ID`');
      const user = await client.users.fetch(id).catch(() => null);
      if (!user) return reply(message, 'Could not find that Discord user.');
      enqueueAudit(message, user);
      return;
    }

    // Changing configuration requires Manage Server permission.
    if (!isManager(message)) return reply(message, 'You need **Manage Server** to change RP bot settings.');

    if (command === '!rphours') {
      const hours = Number(args[0]);
      if (!Number.isInteger(hours) || hours < 1 || hours > 336) {
        return reply(message, 'Usage: `!rphours 48` (between 1 and 336 hours).');
      }
      cfg.hours = hours;
      saveSettings();
      return reply(message, `RP audit window set to ${hours} hours.`);
    }

    const channel = await parseChannel(message, args[0]);
    const supportsThisCommand = (command === '!rpadd' || command === '!rpremove')
      ? isSupportedMonitorChannel(channel)
      : isSupportedChannel(channel);
    if (!supportsThisCommand) {
      return reply(message, `Usage: \`${command} #channel\` (monitoring accepts text, forum, or specific thread IDs; check and log channels must be text channels).`);
    }

    if (command === '!rpadd') {
      if (channel.id === cfg.logChannel) return reply(message, 'The staff log channel cannot be monitored as an RP channel.');
      if (cfg.rpChannels.includes(channel.id)) return reply(message, 'That RP channel is already monitored.');
      cfg.rpChannels.push(channel.id);
      saveSettings();
      return reply(message, `Added <#${channel.id}> to RP monitoring.`);
    }

    if (command === '!rpremove') {
      cfg.rpChannels = cfg.rpChannels.filter(id => id !== channel.id);
      saveSettings();
      return reply(message, `Removed <#${channel.id}> from RP monitoring.`);
    }

    if (command === '!rplogchannel') {
      if (cfg.rpChannels.includes(channel.id)) return reply(message, 'Choose a staff log channel outside the monitored RP channels.');
      cfg.logChannel = channel.id;
      saveSettings();
      return reply(message, `Staff audit logs will be posted to <#${channel.id}>.`);
    }

    if (command === '!rpcheckchannel') {
      cfg.checkChannel = channel.id;
      saveSettings();
      return reply(message, `Members may now submit \`!rpcheck\` in <#${channel.id}>.`);
    }
  } catch (error) {
    console.error('Command error:', error);
    await reply(message, 'An error occurred. Check the bot console and permissions.').catch(() => {});
  }
});

client.login(TOKEN);
