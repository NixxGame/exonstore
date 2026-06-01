/**
 * Exon External — Discord Bot
 * Run standalone: node bot.js
 * Register commands: node bot.js --register
 */

require('dotenv').config();

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');

const db = require('./db');

// ── Role config ───────────────────────────────────────────────────────────────

const ROLE_COLORS  = { member: 0x6B7280, customer: 0xF07A12, staff: 0x4A90D9, developer: 0x9B59B6 };
const ROLE_LABELS  = { member: 'Member', customer: 'Customer', staff: 'Staff', developer: 'Developer' };
const ROLE_ORDER   = ['member', 'customer', 'staff', 'developer'];

// ── Slash command definitions ─────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('checkkey')
    .setDescription('Check if a user has an active Exon license (staff only)')
    .addUserOption(o => o.setName('user').setDescription('Discord user to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('getkey')
    .setDescription('DM a user their license key info (mod only)')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('mykeys')
    .setDescription('DM you your active Exon license keys')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link a license key to your Discord account')
    .addStringOption(o => o.setName('key').setDescription('Your license key').setRequired(true))
    .toJSON(),
];

// ── Register commands (node bot.js --register) ────────────────────────────────

if (process.argv.includes('--register')) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  ).then(() => { console.log('Slash commands registered.'); process.exit(0); })
   .catch(err => { console.error(err); process.exit(1); });
  return;
}

// ── Start bot ─────────────────────────────────────────────────────────────────

function startBot() {
  console.log('Starting Discord bot...');

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not set — bot not started');
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once('ready', () => console.log(`Bot ready as ${client.user.tag}`));

  client.on('error', err => console.error('Bot error:', err.message));

  // Auto-assign Member role on join
  client.on('guildMemberAdd', async member => {
    const roleId = process.env.DISCORD_ROLE_MEMBER;
    if (!roleId) return;
    try { await member.roles.add(roleId); } catch {}
  });

  // Slash commands
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // /checkkey
    if (interaction.commandName === 'checkkey') {
      await interaction.deferReply({ ephemeral: true });
      const target = interaction.options.getUser('user');
      const user   = db.getUser(target.id);
      const keys   = user ? db.getUserKeys(target.id) : [];
      const role   = user?.role ?? 'none';

      const embed = new EmbedBuilder()
        .setColor(ROLE_COLORS[role] ?? 0x404858)
        .setAuthor({ name: target.tag ?? target.username, iconURL: target.displayAvatarURL() })
        .setTitle('License Check')
        .addFields(
          { name: 'Role',        value: ROLE_LABELS[role] ?? 'Not registered', inline: true },
          { name: 'Active Keys', value: String(keys.length), inline: true }
        );

      if (keys.length > 0) {
        embed.addFields({ name: 'Keys', value: keys.map(k => `\`${k.key_value}\` — ${k.plan ?? 'License'}`).join('\n') });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // /mykeys
    if (interaction.commandName === 'mykeys') {
      await interaction.deferReply({ ephemeral: true });
      const keys = db.getUserKeys(interaction.user.id);

      if (!keys.length) {
        await interaction.editReply('You have no active keys linked. Visit **exoncheats.com**, log in with Discord, and paste your key to link it.');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(ROLE_COLORS.customer)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTitle('Your Active Keys')
        .setDescription(keys.map((k, i) =>
          `**${i + 1}.** \`${k.key_value}\`\n` +
          `> Plan: ${k.plan ?? 'License'}`
        ).join('\n\n'))
        .setFooter({ text: 'Keep these private — do not share your keys.' })
        .setTimestamp();

      try {
        await interaction.user.send({ embeds: [embed] });
        await interaction.editReply('✅ Sent to your DMs! Check your direct messages.');
      } catch {
        // DMs closed — reply ephemerally instead
        await interaction.editReply({ content: '❌ I couldn\'t DM you. Please enable DMs from server members in your privacy settings, then try again.', embeds: [embed] });
      }
      return;
    }

    // /getkey (mod only)
    if (interaction.commandName === 'getkey') {
      await interaction.deferReply({ ephemeral: true });
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
          `**${i + 1}.** \`${k.key_value}\`\n` +
          `> Plan: ${k.plan ?? 'License'}\n` +
          `> Created: <t:${k.created_at}:R>`
        ).join('\n\n'))
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();

      // DM the target user
      try {
        await target.send({ embeds: [embed] });
        await interaction.editReply(`✅ Sent **${target.username}**'s key info to their DMs.`);
      } catch {
        // Can't DM target — send to mod ephemerally
        await interaction.editReply({ content: `❌ Couldn't DM ${target.username} (DMs closed). Here's their info:`, embeds: [embed] });
      }
      return;
    }

    // /verify
    if (interaction.commandName === 'verify') {
      await interaction.deferReply({ ephemeral: true });
      const keyValue = interaction.options.getString('key').trim();
      const keyRow   = db.getKey(keyValue);

      if (!keyRow)          { await interaction.editReply('Key not found.'); return; }
      if (!keyRow.active)   { await interaction.editReply('That key is inactive.'); return; }
      if (keyRow.discord_id === interaction.user.id) { await interaction.editReply('Already linked to your account.'); return; }
      if (keyRow.discord_id) { await interaction.editReply('That key is linked to a different account.'); return; }

      // Link key
      db.linkKey(keyValue, interaction.user.id);

      // Ensure user exists
      db.upsertUser(interaction.user.id, interaction.user.username, interaction.user.displayAvatarURL({ size: 128 }));

      // Promote to customer
      const user = db.getUser(interaction.user.id);
      if (!user || ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf('customer')) {
        db.setUserRole(interaction.user.id, 'customer');
      }

      // Assign buyer role in Discord
      const buyerRoleId = process.env.DISCORD_ROLE_CUSTOMER;
      if (buyerRoleId) {
        try {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.add(buyerRoleId);
        } catch {}
      }

      await interaction.editReply('Key linked! You\'ve been granted the **Customer** role.');
      return;
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('Bot login successful'))
    .catch(err => console.error('Bot login failed:', err.message));

  return client;
}

module.exports = { startBot };

// Run standalone
if (require.main === module) startBot();
