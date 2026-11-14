/**
 * RP Check Bot - discord.js 14
 * Members type !rpcheck in the configured check channel.
 * The bot audits recent messages in configured RP channels, sends a staff log,
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
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const STAFF_ROLE_IDS = new Set(
  (process.env.STAFF_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean)
);
const CONFIG_PATH = path.join(__dirname, 'rpcheck-config.json');
const MAX_PAGES_PER_CHANNEL = 50; // up to 5,000 recent messages/channel/check

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

// Per-server configuration; stored locally to survive bot restarts.
let db = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  : {};

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

function parseChannel(message, input) {
  const id = input?.match(/^<#(\d+)>$|^(\d+)$/)?.slice(1).find(Boolean);
  return id ? message.guild.channels.cache.get(id) : null;
}

function isSupportedChannel(channel) {
  return channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type);
}

async function reply(message, content) {
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

function cleanContent(message) {
  let text = message.content.replace(/\s+/g, ' ').trim();
  if (!text) {
    text = message.attachments.size ? `[${message.attachments.size} attachment(s)]` :
      message.embeds.length ? '[embed]' :
      message.stickers.size ? '[sticker]' : '[no text]';
  }
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
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
  const found = [];
  const summaries = [];
  const warnings = [];

  for (const channelId of cfg.rpChannels) {
    const channel = await originMessage.guild.channels.fetch(channelId).catch(() => null);
    if (!isSupportedChannel(channel)) {
      warnings.push(`#${channelId}: missing or unsupported`);
      continue;
    }
    try {
      const { matches, truncated } = await scanChannel(channel, targetUser.id, cutoff);
      summaries.push(`${channel.name}: ${matches.length}`);
      found.push(...matches);
      if (truncated) warnings.push(`#${channel.name}: reached 5,000-message scan cap`);
    } catch (error) {
      console.error(`Cannot audit channel ${channelId}:`, error);
      warnings.push(`#${channel.name}: could not read message history`);
    }
  }

  found.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  // Put the user's name AND permanent ID in EVERY log message, so staff can
  // search the staff-log channel for that ID in Discord's Ctrl+F search.
  const title = `RP AUDIT | ${targetUser.username} | USER ID: ${targetUser.id}`;
  const generatedAt = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  const summary = [
    title,
    `Requested by: ${originMessage.author.username} (${originMessage.author.id}) | ${generatedAt}`,
    `Past ${cfg.hours} hour(s) | Total RP messages: ${found.length}`,
    `Channels: ${summaries.join(' | ') || 'none readable'}`,
    `Status: ${warnings.length ? 'INCOMPLETE - ' + warnings.join('; ') : 'scan completed'}`,
    '---',
  ].join('\n');

  // Every line includes an exact original-message link; copied content is only
  // a preview. No Discord mentions are allowed in posted audit messages.
  const lines = found.map(m =>
    `#${m.channel.name} | <t:${Math.floor(m.createdTimestamp / 1000)}:f> | ${cleanContent(m)}\n${m.url}`
  );

  const pages = [];
  let current = summary;
  const continuation = `${title} | continued\n`;
  for (const line of lines.length ? lines : ['No RP messages found in the configured channels during this time window.']) {
    if ((current + '\n' + line).length > 1850) {
      pages.push(current);
      current = continuation;
    }
    current += '\n' + line + '\n';
  }
  pages.push(current);

  for (const page of pages) {
    await logChannel.send({ content: page, allowedMentions: { parse: [] } });
  }

  // This means "logged successfully," not "staff approved the activity."
  await originMessage.react('✅');
  if (originMessage.content.trim().toLowerCase() !== '!rpcheck') {
    await reply(originMessage, `Audit posted in <#${cfg.logChannel}> (${found.length} message(s)).`);
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
}

client.once(Events.ClientReady, readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
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

    // The commands below are restricted to staff; configure STAFF_ROLE_IDS
    // or grant staff Manage Server permission in Discord.
    if (!['!rpadd', '!rpremove', '!rplist', '!rplogchannel', '!rpcheckchannel', '!rphours', '!rplog'].includes(command)) return;
    if (!isStaff(message)) return reply(message, 'This is a staff-only command.');

    if (command === '!rplist') {
      return reply(message,
        `RP channels: ${cfg.rpChannels.map(id => `<#${id}>`).join(', ') || '(none)'}\n` +
        `Staff log: ${cfg.logChannel ? `<#${cfg.logChannel}>` : '(not set)'}\n` +
        `Check channel: ${cfg.checkChannel ? `<#${cfg.checkChannel}>` : '(any channel until set)'}\n` +
        `Audit window: ${cfg.hours} hours.`
      );
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

    const channel = parseChannel(message, args[0]);
    if (!isSupportedChannel(channel)) {
      return reply(message, `Usage: \`${command} #text-channel\` (mention a regular server text channel).`);
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
