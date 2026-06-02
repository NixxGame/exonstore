/**
 * Exon External — Discord Bot
 * Register commands: node bot.js --register
 */

require('dotenv').config();

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ButtonBuilder,
  ButtonStyle, ActionRowBuilder, PermissionFlagsBits,
} = require('discord.js');

const db    = require('./db');
const axios = require('axios');

const ROLE_COLORS = { member: 0x6B7280, customer: 0xF07A12, staff: 0x4A90D9, developer: 0x9B59B6 };
const ROLE_ORDER  = ['member', 'customer', 'staff', 'developer'];

// ── Commands ──────────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('getkey')
    .setDescription('DM a user their license key info (staff only)')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('mykeys')
    .setDescription('View your active Exon license keys (sent to DMs)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link a license key to your Discord account')
    .addStringOption(o => o.setName('key').setDescription('Your license key (e.g. exon-XXXX-XXXX-XXXX)').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('linksite')
    .setDescription('Get a link to the Exon External website')
    .toJSON(),
];

// ── Register ──────────────────────────────────────────────────────────────────

if (process.argv.includes('--register')) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  ).then(() => { console.log('Commands registered.'); process.exit(0); })
   .catch(err => { console.error(err); process.exit(1); });
  return;
}

// ── CF KV helpers ─────────────────────────────────────────────────────────────

const CF_BASE = () =>
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
const CF_HDR  = () => ({ Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'text/plain' });

async function cfRead(key) {
  try {
    const r = await axios.get(`${CF_BASE()}/values/${encodeURIComponent(key)}`, { headers: CF_HDR() });
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  } catch { return null; }
}
async function cfWrite(key, data) {
  try {
    await axios.put(`${CF_BASE()}/values/${encodeURIComponent(key)}`,
      JSON.stringify(data), { headers: CF_HDR() });
  } catch {}
}

// ── Discord role assign ───────────────────────────────────────────────────────

async function assignRole(guild, userId, envKey) {
  const roleId = process.env[envKey];
  if (!roleId) return;
  try { await (await guild.members.fetch(userId)).roles.add(roleId); } catch {}
}

// ── Status voice channel (rename to 🟢/🔴) ───────────────────────────────────

async function updateStatusChannel(client, online) {
  const channelId = process.env.DISCORD_STATUS_CHANNEL;
  if (!channelId) return;
  try {
    const vc = await client.channels.fetch(channelId);
    if (!vc) return;
    const name = online ? '🟢 Status: Online' : '🔴 Status: Offline';
    if (vc.name !== name) await vc.setName(name);
  } catch (err) {
    console.error('Status VC error:', err.message);
  }
}

// ── Stats voice channel ───────────────────────────────────────────────────────

async function updateStatsVoice(client) {
  const vcId = process.env.DISCORD_STATS_VC;
  if (!vcId) return;
  try {
    const vc = await client.channels.fetch(vcId);
    if (!vc) return;
    const activeUsers = Object.values(
      JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8')).keys ?? {}
    ).filter(k => k.active && k.discord_id).length;
    await vc.setName(`👥 Active Users: ${activeUsers}`);
  } catch {}
}

// ── Bot start ─────────────────────────────────────────────────────────────────

function startBot() {
  console.log('Starting Discord bot...');

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not set — bot not started');
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once('clientReady', async () => {
    console.log(`Bot ready as ${client.user.tag}`);
    await updateStatusChannel(client, true);
    await updateStatsVoice(client);
    // Refresh every 5 minutes
    setInterval(async () => {
      await updateStatusChannel(client, true);
      await updateStatsVoice(client);
    }, 5 * 60 * 1000);
  });

  client.on('error', err => console.error('Bot error:', err.message));

  // Auto-assign Member role on join
  client.on('guildMemberAdd', async member => {
    const roleId = process.env.DISCORD_ROLE_MEMBER;
    if (roleId) try { await member.roles.add(roleId); } catch {}
  });

  // ── Slash commands ────────────────────────────────────────────────────────

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // /mykeys
    if (interaction.commandName === 'mykeys') {
      await interaction.deferReply({ flags: 64 });
      const keys = db.getUserKeys(interaction.user.id);

      if (!keys.length) {
        await interaction.editReply('You have no active keys. Use `/verify <key>` to link one, or visit **exoncheats.com**.');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(ROLE_COLORS.customer)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTitle('Your Active Keys')
        .setDescription(keys.map((k, i) =>
          `**${i + 1}.** \`${k.key_value}\`\n> Plan: ${k.plan ?? 'License'}`
        ).join('\n\n'))
        .setFooter({ text: 'Keep these private — never share your keys.' })
        .setTimestamp();

      try {
        await interaction.user.send({ embeds: [embed] });
        await interaction.editReply('✅ Sent to your DMs!');
      } catch {
        await interaction.editReply({ content: '❌ Couldn\'t DM you — enable DMs from server members and try again.', embeds: [embed] });
      }
      return;
    }

    // /getkey (staff only)
    if (interaction.commandName === 'getkey') {
      await interaction.deferReply({ flags: 64 });
      const target = interaction.options.getUser('user');
      const user   = db.getUser(target.id);
      const keys   = user ? db.getUserKeys(target.id) : [];

      if (!keys.length) {
        await interaction.editReply(`**${target.username}** has no active keys linked.`);
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(ROLE_COLORS[user?.role] ?? 0x404858)
        .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
        .setTitle('License Key Info')
        .setDescription(keys.map((k, i) =>
          `**${i + 1}.** \`${k.key_value}\`\n> Plan: ${k.plan ?? 'License'}\n> Linked: <t:${k.created_at}:R>`
        ).join('\n\n'))
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();

      try {
        await target.send({ embeds: [embed] });
        await interaction.editReply(`✅ Sent **${target.username}**'s key info to their DMs.`);
      } catch {
        await interaction.editReply({ content: `❌ Couldn't DM ${target.username} (DMs closed). Here's their info:`, embeds: [embed] });
      }
      return;
    }

    // /verify
    if (interaction.commandName === 'verify') {
      await interaction.deferReply({ flags: 64 });
      const keyValue = interaction.options.getString('key').trim();
      const keyRow   = db.getKey(keyValue);

      if (!keyRow) {
        await interaction.editReply('❌ Key not found. Double-check your key and try again.');
        return;
      }
      if (keyRow.discord_id === interaction.user.id) {
        await interaction.editReply('✅ This key is already linked to your account.');
        return;
      }
      if (keyRow.discord_id) {
        await interaction.editReply('❌ That key is already linked to a different account.');
        return;
      }

      db.upsertUser(interaction.user.id, interaction.user.username,
        interaction.user.displayAvatarURL({ size: 128 }));
      db.linkKey(keyValue, interaction.user.id);
      db.activateKey(keyValue);

      const user = db.getUser(interaction.user.id);
      if (!user || ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf('customer'))
        db.setUserRole(interaction.user.id, 'customer');

      await assignRole(interaction.guild, interaction.user.id, 'DISCORD_ROLE_CUSTOMER');

      // Sync to CF KV
      const cf = await cfRead(keyValue);
      if (cf) { cf.discord_id = interaction.user.id; cf.active = true; await cfWrite(keyValue, cf); }
      const cfUser = await cfRead(`user:${interaction.user.id}`);
      if (cfUser) {
        const linked = cfUser.linked_keys ?? [];
        if (!linked.includes(keyValue)) {
          cfUser.linked_keys = [...linked, keyValue];
          await cfWrite(`user:${interaction.user.id}`, cfUser);
        }
      }

      // Update stats after new link
      await updateStatsVoice(client);

      const embed = new EmbedBuilder()
        .setColor(ROLE_COLORS.customer)
        .setTitle('✅ Key Linked')
        .setDescription(`\`${keyValue}\` is now linked to your account. You've been given the **Customer** role.\n\nVisit **exoncheats.com** to manage your license and view your dashboard.`)
        .setFooter({ text: 'Exon External' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // /linksite
    if (interaction.commandName === 'linksite') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Open exoncheats.com')
          .setStyle(ButtonStyle.Link)
          .setURL('https://exoncheats.com'),
        new ButtonBuilder()
          .setLabel('Join Discord')
          .setStyle(ButtonStyle.Link)
          .setURL('https://discord.gg/NczWT7nyAs')
      );

      const embed = new EmbedBuilder()
        .setColor(0xF07A12)
        .setTitle('Exon External')
        .setDescription('Purchase a license, manage your account, and link your key all from the website.')
        .addFields(
          { name: '🔑 Link Key',    value: 'Log in with Discord and paste your key', inline: true },
          { name: '🛒 Purchase',    value: 'Secure checkout via Stripe',             inline: true },
          { name: '💬 Support',     value: 'Open a ticket in this server',           inline: true }
        )
        .setFooter({ text: 'Exon External' });

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('Bot login successful'))
    .catch(err => console.error('Bot login failed:', err.message));

  return client;
}

module.exports = { startBot };

if (require.main === module) startBot();
